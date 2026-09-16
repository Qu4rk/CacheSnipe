import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "./log.js";
import { loadPriceTable, type PriceTable } from "./prices.js";
import { renderGraph, renderSummary, type ConfigSnapshot } from "./render.js";
import { MAX_HISTORY_POINTS, type SessionStats } from "./types.js";

/**
 * On-disk stats store.
 *
 * Layout (default dir: ~/.local/share/opencode/deepseek-cache/):
 *   sessions/<sessionID>.json   one record per DeepSeek session
 *   aggregate.json              derived: every session summed
 *   summary.txt                 derived: rendered for the /cache-stats command
 *   graph.txt                   derived: rendered for the /cache-graph command
 *   config.json                 last config snapshot observed via the config hook
 *   cachesnipe.log              plugin log
 *
 * The Desktop server instantiates one plugin per workspace directory, so
 * several instances can touch this directory at once. Every write is therefore
 * atomic (temp file + rename) and every derived file is recomputed from a scan
 * of `sessions/`, which makes concurrent writers converge instead of clobber.
 */

export type StorePaths = {
  dir: string;
  sessions: string;
  aggregate: string;
  summary: string;
  graph: string;
  config: string;
  log: string;
};

export function storePaths(dir: string): StorePaths {
  return {
    dir,
    sessions: join(dir, "sessions"),
    aggregate: join(dir, "aggregate.json"),
    summary: join(dir, "summary.txt"),
    graph: join(dir, "graph.txt"),
    config: join(dir, "config.json"),
    log: join(dir, "cachesnipe.log"),
  };
}

const RETENTION_MS_PER_DAY = 24 * 60 * 60 * 1000;

function writeAtomic(file: string, contents: string): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, contents);
  renameSync(tmp, file);
}

export function mergeSessions(a: SessionStats, b: SessionStats): SessionStats {
  // Used when two plugin instances observed the same session id (possible after
  // a workspace is opened twice): keep the larger counter for each field.
  const pick = (left: number, right: number): number => (left >= right ? left : right);
  return {
    ...a,
    updatedAt: pick(a.updatedAt, b.updatedAt),
    createdAt: Math.min(a.createdAt, b.createdAt),
    turns: pick(a.turns, b.turns),
    requests: pick(a.requests, b.requests),
    cacheRead: pick(a.cacheRead, b.cacheRead),
    cacheWrite: pick(a.cacheWrite, b.cacheWrite),
    missInput: pick(a.missInput, b.missInput),
    output: pick(a.output, b.output),
    reasoning: pick(a.reasoning, b.reasoning),
    cost: pick(a.cost, b.cost),
    prefixBreaks: pick(a.prefixBreaks, b.prefixBreaks),
    systemPromptBreaks: pick(a.systemPromptBreaks, b.systemPromptBreaks),
    rewinds: pick(a.rewinds, b.rewinds),
    compactions: pick(a.compactions, b.compactions),
    history: a.history.length >= b.history.length ? a.history : b.history,
    notes: a.notes.length >= b.notes.length ? a.notes : b.notes,
    milestones: a.milestones.length >= b.milestones.length ? a.milestones : b.milestones,
  };
}

/**
 * Repairs legacy records in place. Older builds counted aborted (zero-usage)
 * assistant messages as turns, so `turns` could exceed the number of history
 * points by one or more phantom turns. Healing applies the inverse operation:
 * drop trailing all-zero history points, then align `turns` with the remaining
 * history (only when it fits, so a history capped at MAX_HISTORY_POINTS is left
 * alone). Everything else is left untouched — the numbers came from the provider.
 */
function healSession(stats: SessionStats, logger: Logger, label: string): SessionStats {
  try {
    let healed = false;
    while (stats.history.length > 0) {
      const last = stats.history[stats.history.length - 1];
      if (!last) break;
      const total = last.cacheRead + last.missInput + last.output + last.cost;
      if (total !== 0) break;
      stats.history.pop();
      healed = true;
    }
    if (
      stats.turns > stats.history.length &&
      stats.history.length < MAX_HISTORY_POINTS &&
      Number.isInteger(stats.turns)
    ) {
      stats.turns = stats.history.length;
      healed = true;
    }
    if (healed) {
      stats.notes = stats.notes ?? [];
      stats.notes.push(`record healed on ${new Date().toISOString().slice(0, 10)}: trailing zero-usage turn(s) from an older build removed and turns re-aligned with history`);
      logger.info("healed legacy session record", { session: label, turns: stats.turns, history: stats.history.length });
    }
    return stats;
  } catch {
    // A record odd enough to throw here is left exactly as it was.
    return stats;
  }
}

export class StatsStore {
  readonly paths: StorePaths;
  private readonly logger: Logger;
  private readonly retentionDays: number;
  private priceTable: PriceTable | undefined;
  private readonly inMemory = new Map<string, SessionStats>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingFlush = new Set<string>();
  /**
   * The session whose stats were written most recently. `summary.txt` and
   * `graph.txt` are shared files, so without this the renderer had no session to
   * show and every report printed "this session (nothing observed yet)" — which is
   * what `/cache-stats` reads out. Last-flushed is the closest thing a shared file
   * has to "the session you are looking at".
   */
  private lastActive: SessionStats | undefined;

  constructor(input: { dir: string; logger: Logger; retentionDays?: number }) {
    this.paths = storePaths(input.dir);
    this.logger = input.logger;
    this.retentionDays = input.retentionDays ?? 30;
    try {
      mkdirSync(this.paths.sessions, { recursive: true });
    } catch (error) {
      this.logger.warn("could not create stats directory", { dir: input.dir, error: String(error) });
    }
  }

  prices(): PriceTable {
    this.priceTable ??= loadPriceTable();
    return this.priceTable;
  }

  read(sessionID: string): SessionStats | undefined {
    if (this.inMemory.has(sessionID)) return this.inMemory.get(sessionID);
    const file = join(this.paths.sessions, `${sessionID}.json`);
    if (!existsSync(file)) return undefined;
    try {
      const parsed = healSession(JSON.parse(readFileSync(file, "utf8")) as SessionStats, this.logger, sessionID);
      this.inMemory.set(sessionID, parsed);
      return parsed;
    } catch (error) {
      this.logger.warn("could not read session stats", { sessionID, error: String(error) });
      return undefined;
    }
  }

  /** Registers a session record in memory (call `markDirty` to schedule the write). */
  put(stats: SessionStats): void {
    const existing = this.inMemory.get(stats.sessionID);
    this.inMemory.set(stats.sessionID, existing ? mergeSessions(stats, existing) : stats);
  }

  markDirty(sessionID: string, delayMs = 1200): void {
    this.pendingFlush.add(sessionID);
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, delayMs);
    // Never hold the process open just for a stats write.
    this.flushTimer.unref?.();
  }

  flush(sessionID?: string): void {
    const ids = sessionID ? [sessionID] : [...this.pendingFlush];
    this.pendingFlush.clear();
    let lastWritten: SessionStats | undefined;
    for (const id of ids) {
      const stats = this.inMemory.get(id);
      if (!stats) continue;
      try {
        stats.updatedAt = Date.now();
        writeAtomic(join(this.paths.sessions, `${id}.json`), `${JSON.stringify(stats, null, 2)}\n`);
        lastWritten = stats;
      } catch (error) {
        this.logger.warn("could not write session stats", { sessionID: id, error: String(error) });
      }
    }
    // A failed write must not blank the report: keep showing the previous session.
    if (lastWritten) this.lastActive = lastWritten;
    if (ids.length > 0) this.writeDerived(lastWritten ?? this.lastActive);
  }

  flushAll(): void {
    for (const id of this.inMemory.keys()) this.pendingFlush.add(id);
    this.flush();
  }

  list(): SessionStats[] {
    const out: SessionStats[] = [];
    let names: string[] = [];
    try {
      names = readdirSync(this.paths.sessions).filter((name) => name.endsWith(".json"));
    } catch {
      return out;
    }
    for (const name of names) {
      const file = join(this.paths.sessions, name);
      try {
        out.push(healSession(JSON.parse(readFileSync(file, "utf8")) as SessionStats, this.logger, name));
      } catch {
        // Corrupt record: skip it rather than failing the whole report.
      }
    }
    return out;
  }

  /**
   * Recomputes aggregate.json/summary.txt/graph.txt from the on-disk scan.
   * Defaults to the last session written, so the rendered reports name a real
   * session instead of the placeholder.
   */
  writeDerived(current: SessionStats | undefined = this.lastActive): void {
    const sessions = this.list();
    // In-memory state is fresher than disk for the session being reported on.
    const merged = sessions.map((session) => {
      const live = this.inMemory.get(session.sessionID);
      return live ? mergeSessions(session, live) : session;
    });
    if (current) {
      const existing = merged.find((session) => session.sessionID === current.sessionID);
      if (existing) Object.assign(existing, current);
      else merged.push(current);
    }

    const config = this.readConfig();
    try {
      writeAtomic(this.paths.aggregate, `${JSON.stringify(merged, null, 2)}\n`);
    } catch (error) {
      this.logger.warn("could not write aggregate.json", { error: String(error) });
    }
    try {
      writeAtomic(
        this.paths.summary,
        renderSummary({ current, sessions: merged, priceTable: this.prices(), config }),
      );
      writeAtomic(this.paths.graph, renderGraph({ current, sessions: merged, priceTable: this.prices() }));
    } catch (error) {
      this.logger.warn("could not write rendered reports", { error: String(error) });
    }
  }

  writeConfig(config: ConfigSnapshot): void {
    try {
      writeAtomic(this.paths.config, `${JSON.stringify(config, null, 2)}\n`);
    } catch (error) {
      this.logger.warn("could not write config snapshot", { error: String(error) });
    }
  }

  readConfig(): ConfigSnapshot | undefined {
    try {
      return JSON.parse(readFileSync(this.paths.config, "utf8")) as ConfigSnapshot;
    } catch {
      return undefined;
    }
  }

  /** Deletes session records untouched for longer than the retention window. */
  cleanup(now = Date.now()): number {
    const cutoff = now - this.retentionDays * RETENTION_MS_PER_DAY;
    let removed = 0;
    let names: string[] = [];
    try {
      names = readdirSync(this.paths.sessions);
    } catch {
      return 0;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const file = join(this.paths.sessions, name);
      try {
        const stats = JSON.parse(readFileSync(file, "utf8")) as SessionStats;
        const stamp = stats.updatedAt || statSync(file).mtimeMs;
        if (stamp < cutoff) {
          rmSync(file);
          this.inMemory.delete(stats.sessionID);
          removed += 1;
        }
      } catch {
        // Unreadable record: leave it alone.
      }
    }
    if (removed > 0) this.writeDerived();
    return removed;
  }
}
