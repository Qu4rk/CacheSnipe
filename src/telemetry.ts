import type { Hooks } from "@opencode-ai/plugin";
import type { Logger } from "./log.js";
import { isDeepseekModel } from "./models.js";
import type { ObservedSession, SessionRegistry } from "./registry.js";
import { warmHitRate } from "./render.js";
import { MAX_HISTORY_POINTS, ZERO_USAGE, type ResolvedOptions, type Usage, type UsageFields } from "./types.js";

/**
 * P1 — telemetry.
 *
 * Assistant messages carry full accounting (`tokens.cache.read/write`, miss
 * `input`, `reasoning`, `output`, `cost`), and opencode re-emits
 * `message.updated` as each step of a message completes. Numbers are cumulative
 * per message, so deltas are recovered by remembering the last value seen for
 * each message id — that makes multi-step (tool-calling) turns add up correctly
 * instead of double counting.
 *
 * Event delivery is scoped: the plugin's `event` hook only receives events whose
 * `location.directory` matches this plugin instance, so counters here are per
 * workspace and the on-disk report merges across workspaces.
 */

export const MILESTONES = [0.5, 0.8, 0.9, 0.95, 0.99];

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

export function readUsage(info: unknown): Usage | undefined {
  const message = record(info);
  if (!message || message["role"] !== "assistant") return undefined;
  const tokens = record(message["tokens"]);
  if (!tokens) return undefined;
  const cache = record(tokens["cache"]) ?? {};
  const id = message["id"];
  const sessionID = message["sessionID"];
  // An aborted request still lands as an assistant message, but carries
  // `error: { name: "AbortedError" }` (or plain "Aborted") and no usage. It is
  // not a request, so it must never become a turn.
  const error = record(message["error"]) ?? message["error"];
  const errored =
    error !== undefined &&
    error !== null &&
    (typeof error === "string" || typeof (error as { name?: unknown }).name === "string");
  if (typeof id !== "string" || typeof sessionID !== "string") return undefined;
  const time = record(message["time"]);
  return {
    messageID: id,
    sessionID,
    modelID: typeof message["modelID"] === "string" ? message["modelID"] : "",
    providerID: typeof message["providerID"] === "string" ? message["providerID"] : "",
    input: num(tokens["input"]),
    output: num(tokens["output"]),
    reasoning: num(tokens["reasoning"]),
    cacheRead: num(cache["read"]),
    cacheWrite: num(cache["write"]),
    cost: num(message["cost"]),
    completed: typeof time?.["completed"] === "number",
    errored,
  };
}

export function fieldsOf(usage: Usage): UsageFields {
  return {
    input: usage.input,
    output: usage.output,
    reasoning: usage.reasoning,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    cost: usage.cost,
  };
}

export function subtract(previous: UsageFields, next: UsageFields): UsageFields {
  const delta = (a: number, b: number): number => Math.max(0, b - a);
  return {
    input: delta(previous.input, next.input),
    output: delta(previous.output, next.output),
    reasoning: delta(previous.reasoning, next.reasoning),
    cacheRead: delta(previous.cacheRead, next.cacheRead),
    cacheWrite: delta(previous.cacheWrite, next.cacheWrite),
    cost: delta(previous.cost, next.cost),
  };
}

export function add(left: UsageFields, right: UsageFields): UsageFields {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    reasoning: left.reasoning + right.reasoning,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    cost: left.cost + right.cost,
  };
}

export function isZero(usage: UsageFields): boolean {
  return (
    usage.input === 0 &&
    usage.output === 0 &&
    usage.reasoning === 0 &&
    usage.cacheRead === 0 &&
    usage.cacheWrite === 0 &&
    usage.cost === 0
  );
}

/** Highest threshold just crossed, so a big jump announces once instead of three times. */
export function reachedMilestone(rate: number, announced: readonly number[]): number | undefined {
  const hit = MILESTONES.filter((milestone) => rate >= milestone && !announced.includes(milestone));
  return hit.length === 0 ? undefined : Math.max(...hit);
}

export type TelemetryDeps = {
  registry: SessionRegistry;
  logger: Logger;
  options: ResolvedOptions;
  onMilestone?: (sessionID: string, rate: number, milestone: number) => void;
  onTurn?: (sessionID: string, stats: { turns: number; cacheRead: number; missInput: number; hitRate: number }) => void;
};

export function createEventHandler(deps: TelemetryDeps): NonNullable<Hooks["event"]> {
  const { registry, logger, options } = deps;

  const finalizeTurn = (session: ObservedSession): void => {
    const stats = session.stats;
    if (!stats) return;
    registry.pushHistory(session);
    const warm = warmHitRate(stats.history);
    const milestone = reachedMilestone(warm, [...session.announcedMilestones]);
    if (milestone !== undefined && stats.history.some((point) => point.turn > 1)) {
      for (const threshold of MILESTONES) {
        if (threshold <= milestone) session.announcedMilestones.add(threshold);
      }
      stats.milestones = [...session.announcedMilestones].sort((a, b) => a - b);
      registry.note(session, `milestone: warm hit rate reached ${(milestone * 100).toFixed(0)}%`);
      logger.info("cache milestone", {
        sessionID: session.sessionID,
        milestone: `${(milestone * 100).toFixed(0)}%`,
        warmHitRate: `${(warm * 100).toFixed(1)}%`,
        turns: stats.turns,
      });
      deps.onMilestone?.(session.sessionID, warm, milestone);
    }
    deps.onTurn?.(session.sessionID, {
      turns: stats.turns,
      cacheRead: stats.cacheRead,
      missInput: stats.missInput,
      hitRate: warm,
    });
    registry.markDirty(session);
  };

  return async ({ event }): Promise<void> => {
    try {
      const properties = record((event as { properties?: unknown }).properties) ?? {};
      switch ((event as { type?: string }).type) {
        case "message.updated": {
          const usage = readUsage(properties["info"]);
          if (!usage) return;
          const identity = { providerID: usage.providerID, modelID: usage.modelID };
          if (!isDeepseekModel(identity, options)) return;

          const session = registry.observe(usage.sessionID);
          const stats = registry.activate(session, identity);
          const seen = session.usageSeen.get(usage.messageID);
          const next = fieldsOf(usage);
          const delta = seen ? subtract(seen, next) : next;
          const newlySeen = !seen;
          registry.rememberUsage(session, usage.messageID, next);

          if (usage.errored) {
            // Aborted placeholder: record it (so it isn't "new" again) but count
            // nothing — there was no request, so there is no turn.
            logger.debug("assistant message aborted; not counted as a turn", {
              sessionID: session.sessionID,
              messageID: usage.messageID,
            });
            return;
          }

          if (isZero(delta) && !newlySeen) {
            if (usage.completed && !session.finalized.has(usage.messageID)) {
              session.finalized.add(usage.messageID);
              finalizeTurn(session);
            }
            return;
          }

          if (!session.turnCounted.has(usage.messageID) && !isZero(delta)) {
            // A "turn" is a message that delivered usage. A placeholder that
            // arrives all-zero first (aborted request, or an empty step) is not a
            // turn yet; if real usage arrives later it counts then, at the tail —
            // so turnIndex stays aligned with history points.
            stats.turns += 1;
            session.turnIndex = stats.turns;
            session.turnCounted.add(usage.messageID);
            if (stats.turns === 1) {
              logger.info("first turn of session is cold by definition", { sessionID: session.sessionID });
              registry.note(session, "turn 1 cold start (nothing to cache yet)");
            }
          }
          stats.cacheRead += delta.cacheRead;
          stats.cacheWrite += delta.cacheWrite;
          stats.missInput += delta.input;
          stats.output += delta.output;
          stats.reasoning += delta.reasoning;
          stats.cost += delta.cost;
          if (usage.providerID) stats.providerID = usage.providerID;
          if (usage.modelID) stats.modelID = usage.modelID;
          session.turnAccumulator = add(session.turnAccumulator, delta);

          const denom = stats.cacheRead + stats.missInput;
          logger.debug("usage", {
            sessionID: session.sessionID,
            model: `${stats.providerID}/${stats.modelID}`,
            cacheRead: delta.cacheRead,
            missInput: delta.input,
            hitRate: denom === 0 ? "0%" : `${((stats.cacheRead / denom) * 100).toFixed(1)}%`,
            cost: delta.cost,
            completed: usage.completed,
          });

          if (usage.completed && !session.finalized.has(usage.messageID) && session.turnCounted.has(usage.messageID)) {
            // Only a message that delivered usage may finalize: a completed
            // zero placeholder (aborted request) must stay unfinalized, so real
            // usage arriving later can still produce its history point.
            session.finalized.add(usage.messageID);
            finalizeTurn(session);
          } else {
            registry.markDirty(session);
          }
          return;
        }

        case "session.idle": {
          const sessionID = properties["sessionID"];
          if (typeof sessionID !== "string") return;
          const session = registry.peek(sessionID);
          if (!session?.stats) return;
          finalizeTurn(session);
          registry.flush(session);
          return;
        }

        case "session.compacted": {
          const sessionID = properties["sessionID"];
          if (typeof sessionID !== "string") return;
          const session = registry.peek(sessionID);
          if (!session?.stats) return;
          session.pendingCompaction = true;
          session.stats.compactions += 1;
          registry.note(session, `compaction at turn ${session.stats.turns} (cache chain restarts)`) ;
          registry.markDirty(session);
          logger.info("compaction completed", { sessionID, compactions: session.stats.compactions });
          return;
        }

        default:
          return;
      }
    } catch (error) {
      logger.warn("event handler failed", {
        error: error instanceof Error ? error.message : String(error),
        type: (event as { type?: string }).type,
      });
    }
  };
}

export const EMPTY_USAGE = ZERO_USAGE;
