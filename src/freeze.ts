import { createHash } from "node:crypto";
import type { Hooks } from "@opencode-ai/plugin";
import type { Logger } from "./log.js";
import { describeModel, isDeepseekModel, modelIdentity } from "./models.js";
import type { SessionRegistry } from "./registry.js";
import type { BlockHashes, ResolvedOptions } from "./types.js";

/**
  * L0 / L0b — system prompt freeze.
 *
 * opencode rebuilds the system prompt on every request. Two parts of it move
 * without the user doing anything:
 *
 *   1. `Today's date: ${new Date().toDateString()}` inside the `<env>` block —
 *      the documented single dynamic line. Left alone it busts the DeepSeek
 *      prefix cache every midnight (and on every resumed session after that).
 *   2. `<available_skills>`, `<mcp_instructions>` and `<available_references>`,
 *      which are derived from disk/MCP state. Skills come from
 *      `{skill,skills}/**\/SKILL.md` in every config directory, from
 *      `~/.agents/skills` and `~/.claude/skills`, and from a walk-up of project
 *      directories; MCP instructions come from live servers. Installing a skill,
 *      unmounting the SD card that holds symlinked skills, or an MCP server that
 *      misses its connect window all rewrite the prompt prefix mid-session.
 *
 * The original extension only knew about (1). We freeze (1) unconditionally and
 * *attribute* (2): hashes are recorded at session start, and any change is
 * reported with the block name and first differing line. With `strictFreeze` the
 * session-start blocks are re-emitted verbatim so the prefix stays identical.
 *
 * The `<env>` hash deliberately normalizes the date line, so a date change is
 * reported as a date change rather than as an env change.
 */

export const DATE_LINE = /Today's date: ?[^\n]*/;
export const WORKING_LINE = /Working directory: ?[^\n]*/;
export const ROOT_LINE = /Workspace root folder: ?[^\n]*/;

/**
 * How much of each session-start block is persisted for line-level attribution.
 * The env block is tiny, the skills list is small, and MCP instructions can be
 * large — the cap keeps every stats write bounded while still locating the drift
 * in the cases that actually happen.
 */
export const MAX_BASELINE_BLOCK_BYTES = 8192;

export type BlockHit = {
  name: "env" | "skills" | "mcp" | "references";
  index: number;
  text: string;
};

const BLOCK_MARKERS: Array<{ name: BlockHit["name"]; markers: string[] }> = [
  { name: "env", markers: ["<env>"] },
  { name: "skills", markers: ["<available_skills>", "Skills provide specialized instructions"] },
  { name: "mcp", markers: ["<mcp_instructions>"] },
  { name: "references", markers: ["<available_references>"] },
];

export function hashText(text: string, length = 16): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, length);
}

export function parseDateLine(text: string): string | undefined {
  const match = DATE_LINE.exec(text);
  if (!match) return undefined;
  const value = match[0].replace(/^Today's date: ?/, "").trim();
  return value.length > 0 ? value : undefined;
}

/** The env block with its date line replaced, so the hash survives midnight. */
export function normalizeEnv(text: string): string {
  return text
    .replace(DATE_LINE, "Today's date: <frozen>")
    .replace(WORKING_LINE, "Working directory: <frozen>")
    .replace(ROOT_LINE, "Workspace root folder: <frozen>");
}

export type FrozenCwd = { working: string; root: string };

export function parseCwd(text: string): FrozenCwd | undefined {
  const working = WORKING_LINE.exec(text)?.[0]?.replace(/^Working directory: ?/, "").trim();
  const root = ROOT_LINE.exec(text)?.[0]?.replace(/^Workspace root folder: ?/, "").trim();
  if (!working || !root) return undefined;
  return { working, root };
}

/** Rewrites every cwd line in place; returns how many elements changed. */
export function applyFrozenCwd(system: string[], frozen: FrozenCwd): number {
  let changed = 0;
  for (let index = 0; index < system.length; index += 1) {
    const text = system[index];
    if (typeof text !== "string") continue;
    let next = text;
    if (WORKING_LINE.test(next)) {
      const current = WORKING_LINE.exec(next)?.[0]?.replace(/^Working directory: ?/, "").trim();
      if (current !== undefined && current !== frozen.working) {
        next = next.replace(WORKING_LINE, `Working directory: ${frozen.working}`);
      }
    }
    if (ROOT_LINE.test(next)) {
      const current = ROOT_LINE.exec(next)?.[0]?.replace(/^Workspace root folder: ?/, "").trim();
      if (current !== undefined && current !== frozen.root) {
        next = next.replace(ROOT_LINE, `Workspace root folder: ${frozen.root}`);
      }
    }
    if (next !== text) {
      system[index] = next;
      changed += 1;
    }
  }
  return changed;
}

/**
 * Sorts `<skill>` entries by `<name>` so directory-scan reorderings collapse to
 * identical bytes. No-op unless the block shape matches. Returns the new text.
 */
export function canonicalizeSkillsBlock(text: string): string {
  if (!text.includes("<available_skills>") || !text.includes("<skill>")) return text;
  const chunks = text.match(/<skill>[\s\S]*?<\/skill>/g);
  if (!chunks || chunks.length < 2) return text;
  const keyOf = (chunk: string): string => /<name>([\s\S]*?)<\/name>/.exec(chunk)?.[1]?.trim() ?? chunk;
  const sorted = [...chunks].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
  if (sorted.every((chunk, i) => chunk === chunks[i])) return text;
  let cursor = 0;
  return text.replace(/<skill>[\s\S]*?<\/skill>/g, () => sorted[cursor++] ?? "");
}

/**
 * Sorts `<server ...>...</server>` entries by name so MCP connect-order jitter
 * collapses to identical bytes. No-op unless the shape matches.
 */
export function canonicalizeMcpBlock(text: string): string {
  if (!text.includes("<mcp_instructions>") || !text.includes("</server>")) return text;
  const chunks = text.match(/<server[\s\S]*?<\/server>/g);
  if (!chunks || chunks.length < 2) return text;
  const keyOf = (chunk: string): string =>
    /name="([^"]+)"/.exec(chunk)?.[1]?.trim() ?? /<name>([\s\S]*?)<\/name>/.exec(chunk)?.[1]?.trim() ?? chunk;
  const sorted = [...chunks].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
  if (sorted.every((chunk, i) => chunk === chunks[i])) return text;
  let cursor = 0;
  return text.replace(/<server[\s\S]*?<\/server>/g, () => sorted[cursor++] ?? "");
}

/** Canonicalizes skills/MCP ordering in place; returns how many elements changed. */
export function canonicalizeSystem(system: string[]): number {
  let changed = 0;
  for (let index = 0; index < system.length; index += 1) {
    const text = system[index];
    if (typeof text !== "string") continue;
    let next = canonicalizeSkillsBlock(text);
    next = canonicalizeMcpBlock(next);
    if (next !== text) {
      system[index] = next;
      changed += 1;
    }
  }
  return changed;
}

export function scanBlocks(system: readonly string[]): BlockHit[] {
  const hits: BlockHit[] = [];
  const claimed = new Set<number>();
  for (const { name, markers } of BLOCK_MARKERS) {
    for (let index = 0; index < system.length; index += 1) {
      if (claimed.has(index)) continue;
      const text = system[index];
      if (typeof text !== "string") continue;
      if (!markers.some((marker) => text.includes(marker))) continue;
      hits.push({ name, index, text });
      claimed.add(index);
      break;
    }
  }
  return hits;
}

export function hashBlocks(hits: readonly BlockHit[], dateText: string | undefined): BlockHashes {
  const hashes: BlockHashes = {};
  for (const hit of hits) {
    hashes[hit.name] = hashText(hit.name === "env" ? normalizeEnv(hit.text) : hit.text);
  }
  if (dateText !== undefined) hashes["date"] = hashText(dateText);
  return hashes;
}

export function firstDifferingLine(
  before: string,
  after: string,
): { line: number; before: string; after: string } | undefined {
  const left = before.split("\n");
  const right = after.split("\n");
  const max = Math.max(left.length, right.length);
  for (let index = 0; index < max; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === b) continue;
    return { line: index + 1, before: (a ?? "<missing>").trim(), after: (b ?? "<missing>").trim() };
  }
  return undefined;
}

/** Rewrites every date line in place; returns how many elements changed. */
export function applyFrozenDate(system: string[], frozenDate: string): number {
  let changed = 0;
  for (let index = 0; index < system.length; index += 1) {
    const text = system[index];
    if (typeof text !== "string" || !DATE_LINE.test(text)) continue;
    if (parseDateLine(text) === frozenDate) continue;
    system[index] = text.replace(DATE_LINE, `Today's date: ${frozenDate}`);
    changed += 1;
  }
  return changed;
}

export function changedBlocks(previous: BlockHashes, next: BlockHashes): string[] {
  const names = new Set([...Object.keys(previous), ...Object.keys(next)]);
  const changed: string[] = [];
  for (const name of names) {
    if ((previous[name] ?? "none") !== (next[name] ?? "none")) changed.push(name);
  }
  return changed;
}

const BLOCK_HINTS: Record<string, string> = {
  skills: "a skill was added/removed/edited, or a skills directory (possibly a symlinked one) disappeared",
  mcp: "an MCP server changed its instructions or failed to connect",
  references: "project references changed",
  env: "the environment block changed (model id or platform string; date/cwd are frozen separately)",
  date: "the date line changed",
};

export type FreezeDeps = {
  registry: SessionRegistry;
  logger: Logger;
  options: ResolvedOptions;
  onPromptBreak?: (sessionID: string, summary: string) => void;
  onFrozen?: (sessionID: string, frozenDate: string, observedDate: string) => void;
};

export function createSystemTransform(deps: FreezeDeps): NonNullable<Hooks["experimental.chat.system.transform"]> {
  const { registry, logger, options } = deps;

  return async (input, output): Promise<void> => {
    const system = output.system;
    if (!Array.isArray(system) || system.length === 0) return;

    const identity = modelIdentity(input.model);
    if (!isDeepseekModel(identity, options)) return;

    const sessionID = input.sessionID;
    if (!sessionID) {
      logger.debug("system transform without session id", { model: describeModel(identity) });
      return;
    }

    const hits = scanBlocks(system);
    const envHit = hits.find((hit) => hit.name === "env");
    const observedDate = envHit ? parseDateLine(envHit.text) : undefined;
    if (!observedDate) {
      // Not a normal session prompt (title generation, summaries, ...): nothing
      // to freeze and nothing worth reporting.
      logger.debug("no env date line in system prompt; skipping", { sessionID });
      return;
    }

    const session = registry.observe(sessionID);
    registry.activate(session, identity);

    // Stale-resume hint (warmup:true only): the disk cache is best-effort and
    // expires in hours, so a session idle that long is likely evicted. Surfacing
    // it as a note puts it in /cache-stats where the agent already looks, and
    // the agent can then run /cache-warm on its own. Fixed text so it dedupes.
    if (
      options.warmup &&
      session.stats &&
      session.stats.turns > 0 &&
      Date.now() - (session.stats.updatedAt ?? 0) > 2 * 60 * 60 * 1000
    ) {
      registry.note(
        session,
        "cache likely evicted after an idle gap (disk cache expires in hours): suggest /cache-warm before the next large turn",
      );
    }

    // Canonicalize tool ordering first so the baseline is the stable form.
    // Directory-scan reorderings then collapse to identical bytes.
    const canonicalized = canonicalizeSystem(system);
    if (canonicalized > 0) {
      logger.debug("canonicalized skills/mcp block ordering", { sessionID, blocks: canonicalized });
    }

    // L0 — freeze the date. A persisted value wins so a resumed session keeps
    // the cache chain it already paid for.
    if (!session.frozenDate) {
      session.frozenDate = session.stats?.frozenDate || observedDate;
      if (session.frozenDate !== observedDate) {
        logger.info("date frozen from persisted session record", { sessionID, frozen: session.frozenDate });
      } else {
        logger.info("date frozen", { sessionID, frozenDate: session.frozenDate });
      }
      deps.onFrozen?.(sessionID, session.frozenDate, observedDate);
    } else if (session.frozenDate !== observedDate) {
      logger.debug("rewriting drifted date line", { sessionID, observed: observedDate, frozen: session.frozenDate });
    }
    applyFrozenDate(system, session.frozenDate);

    // L0c — freeze the working directories. Same pattern as the date: capture on
    // first sight, persist on disk, rewrite drift on every turn (including
    // resumes and app restarts) so the prefix stays byte-identical. Rewritten
    // lines never count as breaks because hashing happens after freezing and
    // normalizeEnv ignores cwd lines.
    const observedCwd = envHit ? parseCwd(envHit.text) : undefined;
    if (observedCwd) {
      if (!session.frozenCwd) {
        session.frozenCwd = session.stats?.frozenCwd ?? observedCwd;
        if (session.stats) session.stats.frozenCwd = session.frozenCwd;
        logger.info("cwd frozen", { sessionID, ...session.frozenCwd });
      }
      applyFrozenCwd(system, session.frozenCwd);
    }

    // L0b — hash the blocks *after* freezing so the baseline matches what we send.
    const blockHits = scanBlocks(system);
    const nextHashes = hashBlocks(blockHits, session.frozenDate);
    const hadBaseline = Object.keys(session.blocks).length > 0;

    if (!hadBaseline) {
      session.blocks = nextHashes;
      session.promptHash = hashText(system.join("\n----\n"));
      // Attribution is the point of L0b, and without the baseline text a drift can
      // only be named, not located. A bounded copy is therefore persisted for every
      // session — a restart mid-session (which is exactly when the prompt blocks can
      // move) would otherwise leave the next drift unlocatable, and one such drift
      // cost 23,424 tokens on 2026-09-16. The unbounded copy stays strictFreeze-only,
      // because that one is re-emitted and can be large.
      const snapshot: Record<string, string> = {};
      for (const hit of blockHits) snapshot[hit.name] = system[hit.index] ?? hit.text;
      session.baselineBlocks = {};
      for (const [name, text] of Object.entries(snapshot)) {
        if (text.length <= MAX_BASELINE_BLOCK_BYTES) session.baselineBlocks[name] = text;
      }
      if (session.stats && Object.keys(session.baselineBlocks).length > 0) {
        session.stats.baselineBlocks = session.baselineBlocks;
      }
      if (options.strictFreeze) {
        session.frozenBlocks = snapshot;
        if (session.stats) session.stats.frozenBlocks = session.frozenBlocks;
      }
      logger.info("prompt baseline recorded", {
        sessionID,
        promptHash: session.promptHash,
        blocks: Object.keys(nextHashes),
        strictFreeze: options.strictFreeze,
      });
      if (session.stats) registry.markDirty(session);
      return;
    }

    const changed = changedBlocks(session.blocks, nextHashes);
    if (changed.length > 0) {
      const restored = new Set<string>();
      const details: string[] = [];
      // Measured from the scan snapshot, before the replay overwrites anything:
      // re-scanning after the replay would compare the baseline with itself.
      let withheldBytes = 0;
      for (const name of changed) {
        const before = session.frozenBlocks[name] ?? session.baselineBlocks[name];
        const hit = scanBlocks(system).find((candidate) => candidate.name === name);
        const after = hit?.text;
        if (options.strictFreeze && before !== undefined && hit) {
          system[hit.index] = before;
          restored.add(name);
          withheldBytes += Math.max(0, (after?.length ?? 0) - before.length);
        }
        const diff =
          before !== undefined && after !== undefined ? firstDifferingLine(before, after) : undefined;
        const located = diff
          ? ` line ${diff.line}: "${diff.before}" -> "${diff.after}"`
          : before === undefined
            ? ` (no baseline text retained: the block appeared mid-session, or it is larger than the ${MAX_BASELINE_BLOCK_BYTES} byte snapshot limit)`
            : " (block is gone from the prompt)";
        details.push(`${name} (${BLOCK_HINTS[name] ?? "changed"})${located}`);
      }

      const stillChanged = changed.filter((name) => !restored.has(name));
      if (stillChanged.length > 0) {
        const stats = session.stats;
        if (stats) {
          stats.systemPromptBreaks += 1;
          registry.note(session, `prompt break: ${details.join("; ")}`);
          registry.markDirty(session);
        }
        logger.warn("system prompt changed mid-session", {
          sessionID,
          changed: stillChanged,
          details,
          frozen: options.strictFreeze ? restored.size : 0,
        });
        deps.onPromptBreak?.(sessionID, details.join("; "));
      } else {
        logger.info("system prompt drift re-frozen (strictFreeze)", { sessionID, changed, details, withheldBytes });
        registry.note(
          session,
          `strictFreeze replayed ${changed.join(", ")} to keep the prefix; ${withheldBytes} bytes of new content withheld until the next session`,
        );
      }
    }

    // Re-baseline only when nothing changed, so `changedBlocks` keeps reporting
    // the same cause instead of silently accepting it.
    if (changed.length === 0) {
      session.blocks = nextHashes;
      session.promptHash = hashText(system.join("\n----\n"));
    } else {
      session.blocks = hashBlocks(scanBlocks(system), session.frozenDate);
    }
  };
}
