import type { Logger } from "./log.js";
import { mergeSessions, type StatsStore } from "./store.js";
import { MAX_HISTORY_POINTS, ZERO_USAGE, type BlockHashes, type ChainPoint, type ModelIdentity, type SessionStats, type UsageFields } from "./types.js";

/**
 * Session registry.
 *
 * Plugin state is per workspace directory (opencode builds one plugin instance
 * per directory), but the hooks give us little more than a session id. The
 * registry keeps a lightweight in-memory record for every session we touch and
 * only *promotes* a record to a persisted, counted `SessionStats` when the
 * session is confirmed to be DeepSeek. Non-DeepSeek sessions therefore never
 * write a byte, which is how the "control session is untouched" criterion is met.
 */

export type ObservedSession = {
  sessionID: string;
  directory: string;
  active: boolean;
  stats: SessionStats | undefined;
  /** Session-start date, reused across resumes so the cache chain survives. */
  frozenDate: string;
  /** Raw session-start blocks; persisted only when strictFreeze is on. */
  frozenBlocks: Record<string, string>;
  /**
   * Session-start block text held in memory so drift can name the first differing
   * line. Kept out of the persisted record unless strictFreeze is on, because the
   * blocks can be large; a resumed session therefore attributes drift by name and
   * hint only until it re-reads a baseline.
   */
  baselineBlocks: Record<string, string>;
  blocks: BlockHashes;
  promptHash: string;
  /** Last prefix chain observed by the guard (hashes only). */
  chain: ChainPoint[];
  /** Cumulative usage per assistant message id, to recover per-update deltas. */
  usageSeen: Map<string, UsageFields>;
  turnAccumulator: UsageFields;
  turnIndex: number;
  /** Assistant message ids whose turn already produced a history point. */
  finalized: Set<string>;
  /** Assistant message ids that have been counted as a turn (delivered usage). */
  turnCounted: Set<string>;
  pendingCompaction: boolean;
  announcedMilestones: Set<number>;
  announcedBreaks: number;
  announcedPromptBreaks: number;
  touchedAt: number;
};

const MAX_HISTORY = MAX_HISTORY_POINTS;
const MAX_OBSERVED = 128;
const MAX_USAGE_SEEN = 400;
const MAX_CHAIN_PERSISTED = 100;

function freshStats(sessionID: string, directory: string, identity: ModelIdentity | undefined, now: number): SessionStats {
  return {
    sessionID,
    directory,
    providerID: identity?.providerID ?? "",
    modelID: identity?.modelID ?? "",
    frozenDate: "",
    createdAt: now,
    updatedAt: now,
    turns: 0,
    requests: 0,
    cacheRead: 0,
    cacheWrite: 0,
    missInput: 0,
    output: 0,
    reasoning: 0,
    cost: 0,
    prefixBreaks: 0,
    systemPromptBreaks: 0,
    rewinds: 0,
    compactions: 0,
    promptHash: "",
    blocks: {},
    history: [],
    milestones: [],
    notes: [],
    chain: [],
  };
}

export class SessionRegistry {
  private readonly store: StatsStore;
  private readonly directory: string;
  private readonly logger: Logger;
  private readonly observed = new Map<string, ObservedSession>();

  constructor(input: { store: StatsStore; directory: string; logger: Logger }) {
    this.store = input.store;
    this.directory = input.directory;
    this.logger = input.logger;
  }

  observe(sessionID: string): ObservedSession {
    const existing = this.observed.get(sessionID);
    if (existing) {
      existing.touchedAt = Date.now();
      return existing;
    }
    const restored = this.store.read(sessionID);
    const session: ObservedSession = {
      sessionID,
      directory: restored?.directory ?? this.directory,
      active: false,
      stats: undefined,
      frozenDate: restored?.frozenDate ?? "",
      frozenBlocks: restored?.frozenBlocks ?? {},
      baselineBlocks: { ...(restored?.baselineBlocks ?? restored?.frozenBlocks ?? {}) },
      blocks: restored?.blocks ?? {},
      promptHash: restored?.promptHash ?? "",
      chain: (restored?.chain ?? []).map((hash) => ({ hash, id: "", role: "" })),
      usageSeen: new Map(),
      turnAccumulator: { ...ZERO_USAGE },
      turnIndex: restored?.turns ?? 0,
      finalized: new Set(),
      turnCounted: new Set(),
      pendingCompaction: false,
      announcedMilestones: new Set(restored?.milestones ?? []),
      announcedBreaks: 0,
      announcedPromptBreaks: 0,
      touchedAt: Date.now(),
    };
    // A restored record is only "active" once we see a DeepSeek request for it.
    this.observed.set(sessionID, session);
    this.evictIfNeeded();
    return session;
  }

  peek(sessionID: string): ObservedSession | undefined {
    return this.observed.get(sessionID);
  }

  /** Promotes a session to counted/persisted state. Idempotent. */
  activate(session: ObservedSession, identity: ModelIdentity | undefined): SessionStats {
    if (session.stats) {
      if (identity?.providerID) session.stats.providerID = identity.providerID;
      if (identity?.modelID) session.stats.modelID = identity.modelID;
      session.stats.directory = session.directory;
      return session.stats;
    }
    const now = Date.now();
    const existing = this.store.read(session.sessionID);
    const stats = existing ? mergeSessions(existing, freshStats(session.sessionID, session.directory, identity, now)) : freshStats(session.sessionID, session.directory, identity, now);
    if (existing) {
      // Preserve everything learned in an earlier process (frozen date, chain, totals).
      stats.frozenDate = existing.frozenDate || session.frozenDate;
      stats.blocks = existing.blocks ?? {};
      stats.promptHash = existing.promptHash ?? "";
      stats.providerID = identity?.providerID || existing.providerID;
      stats.modelID = identity?.modelID || existing.modelID;
      stats.createdAt = existing.createdAt || now;
      session.chain = (existing.chain ?? []).map((hash) => ({ hash, id: "", role: "" }));
    }
    session.active = true;
    session.stats = stats;
    this.store.put(stats);
    return stats;
  }

  turn(session: ObservedSession): SessionStats | undefined {
    return session.stats;
  }

  note(session: ObservedSession, text: string): void {
    const stats = session.stats;
    if (!stats) return;
    if (stats.notes.includes(text)) return;
    stats.notes.push(text);
    if (stats.notes.length > 40) stats.notes.splice(0, stats.notes.length - 40);
  }

  pushHistory(session: ObservedSession): void {
    const stats = session.stats;
    if (!stats) return;
    const usage = session.turnAccumulator;
    // `session.idle` also finalizes, and a turn that produced no usage must not
    // become a phantom 0% point that drags the warm hit rate down.
    const total =
      usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite + usage.cost;
    if (total <= 0) return;
    const last = stats.history[stats.history.length - 1];
    if (last && last.turn >= session.turnIndex) return;
    const denom = usage.cacheRead + usage.input;
    stats.history.push({
      turn: session.turnIndex,
      at: Date.now(),
      cacheRead: usage.cacheRead,
      missInput: usage.input,
      output: usage.output,
      cost: usage.cost,
      hitRate: denom === 0 ? 0 : usage.cacheRead / denom,
    });
    if (stats.history.length > MAX_HISTORY) stats.history.splice(0, stats.history.length - MAX_HISTORY);
    session.turnAccumulator = { ...ZERO_USAGE };
  }

  markDirty(session: ObservedSession): void {
    const stats = session.stats;
    if (!stats) return;
    stats.chain = session.chain.slice(-MAX_CHAIN_PERSISTED).map((point) => point.hash);
    stats.frozenDate = session.frozenDate || stats.frozenDate;
    stats.promptHash = session.promptHash || stats.promptHash;
    stats.blocks = { ...stats.blocks, ...session.blocks };
    if (session.frozenBlocks && Object.keys(session.frozenBlocks).length > 0) {
      stats.frozenBlocks = session.frozenBlocks;
    }
    this.store.put(stats);
    this.store.markDirty(session.sessionID);
  }

  flush(session?: ObservedSession): void {
    if (session) {
      this.markDirty(session);
      this.store.flush(session.sessionID);
      return;
    }
    this.store.flushAll();
  }

  /** Sessions we have counted in this process, for the report. */
  activeSessions(): SessionStats[] {
    const out: SessionStats[] = [];
    for (const session of this.observed.values()) if (session.stats) out.push(session.stats);
    return out;
  }

  rememberUsage(session: ObservedSession, messageID: string, usage: UsageFields): void {
    session.usageSeen.set(messageID, usage);
    if (session.usageSeen.size > MAX_USAGE_SEEN) {
      const oldest = session.usageSeen.keys().next();
      if (!oldest.done && oldest.value !== undefined) session.usageSeen.delete(oldest.value);
    }
  }

  private evictIfNeeded(): void {
    if (this.observed.size <= MAX_OBSERVED) return;
    let victimKey: string | undefined;
    let victimTouched = Number.POSITIVE_INFINITY;
    for (const [id, session] of this.observed) {
      if (session.stats) continue; // never evict a counted session
      if (session.touchedAt < victimTouched) {
        victimTouched = session.touchedAt;
        victimKey = id;
      }
    }
    if (victimKey) this.observed.delete(victimKey);
  }
}
