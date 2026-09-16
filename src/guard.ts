import type { Hooks } from "@opencode-ai/plugin";
import type { Logger } from "./log.js";
import type { SessionRegistry } from "./registry.js";
import { hashText } from "./freeze.js";
import type { ChainPoint, Verdict } from "./types.js";

/**
 * P2 — message prefix guard.
 *
 * DeepSeek bills by matching the longest identical *prefix*. The system prompt is
 * only part of that prefix: the tool definitions and the whole message history
 * precede the new turn, so anything that rewrites history (opencode's
 * `compaction.prune` replacing old tool outputs, an `/undo`, a compaction) moves
 * the boundary.
 *
 * The hook input carries no session id, so attribution comes from
 * `output.messages[i].info.sessionID` — no need to skip the compaction
 * invocation as the upstream extension did.
 *
 * Classification distinguishes the cases that matter:
 *   extension  — normal turn, history grew, cache intact
 *   rewind     — history was truncated (`/undo` + retry): still a prefix of the
 *                previous chain, so the cache is intact and this is NOT a break
 *   compaction — history replaced by a summary; expected, not a break
 *   divergence — an *earlier* message changed: the cache is broken
 */

export const PROJECTED_PART_TYPES = new Set(["text", "reasoning", "tool", "file", "agent", "patch"]);

function toolProjection(part: Record<string, unknown>): unknown {
  const state = (part["state"] as Record<string, unknown> | undefined) ?? undefined;
  return {
    type: part["type"],
    tool: part["tool"] ?? null,
    callID: part["callID"] ?? null,
    status: state?.["status"] ?? null,
    input: state?.["input"] ?? null,
    output: state?.["output"] ?? null,
    title: state?.["title"] ?? null,
  };
}

function textProjection(part: Record<string, unknown>): unknown {
  return { type: part["type"], text: part["text"] ?? null };
}

/**
 * Canonical view of a message: only content that is actually replayed to the
 * provider, with streaming-only fields dropped so a completed tool result does
 * not look like a rewrite. `snapshot`/`step-start`/`step-finish` parts carry
 * snapshot ids and cumulative costs and are excluded on purpose.
 */
export function projectParts(parts: unknown): unknown[] {
  if (!Array.isArray(parts)) return [];
  const out: unknown[] = [];
  for (const raw of parts) {
    if (!raw || typeof raw !== "object") continue;
    const part = raw as Record<string, unknown>;
    const type = part["type"];
    if (typeof type !== "string" || !PROJECTED_PART_TYPES.has(type)) continue;
    if (type === "tool") out.push(toolProjection(part));
    else if (type === "patch") out.push({ type, hash: part["hash"] ?? null, files: part["files"] ?? null });
    else out.push(textProjection(part));
  }
  return out;
}

export function messageHash(message: unknown): ChainPoint {
  const record = (message ?? {}) as Record<string, unknown>;
  const info = (record["info"] ?? {}) as Record<string, unknown>;
  const id = typeof info["id"] === "string" ? info["id"] : "";
  const role = typeof info["role"] === "string" ? info["role"] : "unknown";
  const sessionID = typeof info["sessionID"] === "string" ? info["sessionID"] : "";
  const payload = { role, sessionID, parts: projectParts(record["parts"]) };
  return { hash: hashText(JSON.stringify(payload), 20), id, role };
}

export function chainOf(messages: unknown): ChainPoint[] {
  if (!Array.isArray(messages)) return [];
  return messages.map((message) => messageHash(message));
}

export function isPrefixOf(shorter: readonly string[], longer: readonly string[]): boolean {
  if (shorter.length > longer.length) return false;
  for (let index = 0; index < shorter.length; index += 1) {
    if (shorter[index] !== longer[index]) return false;
  }
  return true;
}

export function classify(previous: readonly string[], next: readonly ChainPoint[], opts: { compaction: boolean }): Verdict {
  const nextHashes = next.map((point) => point.hash);
  if (previous.length === 0) return { kind: "first", index: 0 };

  const limit = Math.min(previous.length, nextHashes.length);
  let firstDiff = -1;
  for (let index = 0; index < limit; index += 1) {
    if (previous[index] !== nextHashes[index]) {
      firstDiff = index;
      break;
    }
  }

  if (opts.compaction && nextHashes.length < previous.length) {
    return { kind: "compaction", index: firstDiff === -1 ? nextHashes.length : firstDiff };
  }

  if (firstDiff === -1) {
    if (nextHashes.length >= previous.length) return { kind: "extension", index: previous.length };
    return { kind: "rewind", index: nextHashes.length };
  }

  if (nextHashes.length <= previous.length && isPrefixOf(nextHashes, previous)) {
    return { kind: "rewind", index: nextHashes.length };
  }

  const at = next[firstDiff];
  return {
    kind: "divergence",
    index: firstDiff,
    at: at ? { id: at.id, role: at.role } : undefined,
    detail:
      nextHashes.length === previous.length
        ? `message ${firstDiff} changed in place (history length unchanged at ${previous.length})`
        : `message ${firstDiff} changed (history ${previous.length} -> ${nextHashes.length})`,
  };
}

export type GuardDeps = {
  registry: SessionRegistry;
  logger: Logger;
  onBreak?: (sessionID: string, verdict: Verdict) => void;
};

export function createMessagesTransform(deps: GuardDeps): NonNullable<Hooks["experimental.chat.messages.transform"]> {
  const { registry, logger } = deps;

  return async (_input, output): Promise<void> => {
    const messages = output.messages;
    if (!Array.isArray(messages) || messages.length === 0) return;

    const firstInfo = (messages[0] as { info?: { sessionID?: unknown } } | undefined)?.info;
    const sessionID = typeof firstInfo?.sessionID === "string" ? firstInfo.sessionID : undefined;
    if (!sessionID) {
      logger.debug("messages transform without attributable session id; skipping guard");
      return;
    }

    const session = registry.peek(sessionID) ?? registry.observe(sessionID);
    const next = chainOf(messages);
    const verdict = classify(
      session.chain.map((point) => point.hash),
      next,
      { compaction: session.pendingCompaction },
    );

    session.chain = next;
    if (verdict.kind === "first") return;

    const stats = session.stats;
    if (stats) {
      stats.requests += 1;
      if (verdict.kind === "divergence") {
        stats.prefixBreaks += 1;
        registry.note(
          session,
          `prefix break #${stats.prefixBreaks} at message ${verdict.index}${verdict.at ? ` (${verdict.at.role} ${verdict.at.id})` : ""}: ${verdict.detail ?? ""}`,
        );
      } else if (verdict.kind === "rewind") {
        stats.rewinds += 1;
      }
      registry.markDirty(session);
    }

    if (verdict.kind === "divergence") {
      logger.warn("prefix break detected", {
        sessionID,
        index: verdict.index,
        at: verdict.at,
        detail: verdict.detail,
        messages: next.length,
        counted: Boolean(stats),
      });
      deps.onBreak?.(sessionID, verdict);
    } else if (verdict.kind === "compaction") {
      logger.info("history replaced by compaction; cache chain restarts", { sessionID, messages: next.length });
      session.pendingCompaction = false;
    } else {
      logger.debug("prefix verdict", { sessionID, kind: verdict.kind, index: verdict.index, messages: next.length });
    }
  };
}
