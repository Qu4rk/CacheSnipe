/**
 * Shared types.
 *
 * Everything here is deliberately structural and free of runtime imports so the
 * plugin keeps working when opencode's own type surface moves. Hooks are typed
 * at the boundary via `Hooks` from `@opencode-ai/plugin`; payloads we inspect
 * deeply are narrowed with the guards below.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** DeepSeek pricing for one model, in USD per 1M tokens. */
export type ModelPrice = {
  input: number;
  output: number;
  cacheRead: number;
  origin: "models.json" | "fallback";
};

/** Token accounting for a single assistant message (cumulative across its steps). */
export type Usage = {
  messageID: string;
  sessionID: string;
  modelID: string;
  providerID: string;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  completed: boolean;
  /** Aborted/errored assistant message — a placeholder, not a request. */
  errored: boolean;
};

export type UsageFields = Omit<
  Usage,
  "messageID" | "sessionID" | "modelID" | "providerID" | "completed" | "errored"
>;

export const ZERO_USAGE: UsageFields = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
};

/**
 * Maximum trend points kept per session. Lives here (not in the registry) so the
 * store's healing can distinguish "history was capped" from "turns were
 * over-counted by an older build" without importing the registry.
 */
export const MAX_HISTORY_POINTS = 200;

/** One request's worth of cache accounting, used for the trend chart. */
export type TurnPoint = {
  turn: number;
  at: number;
  cacheRead: number;
  missInput: number;
  output: number;
  cost: number;
  hitRate: number;
};

/** Which discovered prompt sections we hash, so a bust can be attributed. */
export type BlockHashes = Record<string, string>;

export type SessionStats = {
  sessionID: string;
  directory: string;
  providerID: string;
  modelID: string;
  /** Session-start date, persisted so a resumed session keeps its cache chain. */
  frozenDate: string;
  /**
   * Session-start working directories, persisted so a resumed session or a
   * restarted app keeps its cache chain. Rewritten on every turn like the date.
   */
  frozenCwd?: { working: string; root: string };
  /** Raw session-start blocks, only persisted when strictFreeze is enabled. */
  frozenBlocks?: Record<string, string>;
  /**
   * Bounded session-start block text, persisted so a drift can be located by line
   * even after a restart. Attribution is the point of L0b, and without this a
   * resumed session can only name the block, not the line that moved.
   */
  baselineBlocks?: Record<string, string>;
  createdAt: number;
  updatedAt: number;
  /** Assistant messages observed (the unit the hit-rate target is measured in). */
  turns: number;
  /** Model requests observed by the prefix guard. */
  requests: number;
  cacheRead: number;
  cacheWrite: number;
  missInput: number;
  output: number;
  reasoning: number;
  cost: number;
  prefixBreaks: number;
  systemPromptBreaks: number;
  rewinds: number;
  compactions: number;
  promptHash: string;
  blocks: BlockHashes;
  history: TurnPoint[];
  milestones: number[];
  /** Human-readable notes for the summary file (break causes, last verdict, ...). */
  notes: string[];
  /** Tail of the last prefix chain (hashes only) so the guard survives a restart. */
  chain: string[];
};

export type ModelIdentity = {
  providerID: string;
  modelID: string;
};

/** One message in the prompt prefix, identified by content hash. */
export type ChainPoint = {
  hash: string;
  id: string;
  role: string;
};

/** Normalized plugin options, accepted as the second element of the config plugin entry. */
export type ResolvedOptions = {
  enabled: boolean;
  /** Extra provider prefixes that should activate the plugin (empty = auto-detect DeepSeek). */
  providers: string[];
  /** Extra model id fragments that should activate the plugin. */
  models: string[];
  statsDir: string;
  retentionDays: number;
  /** Re-emit the session-start prompt blocks to guarantee an identical prefix. */
  strictFreeze: boolean;
  compactionPrompt: "context" | "replace" | "off";
  /** macOS notification on milestones and breaks. */
  notifications: boolean;
  /** Append `[cache 96%]` to the session title (desktop-visible status line substitute). */
  sessionTitle: boolean;
  /**
   * Opt-in explicit cache warm-up. The plugin itself never fires network
   * requests from hooks; when true it only logs the `npm run warmup` hint.
   * The actual ping lives in `scripts/warmup.mjs`.
   */
  warmup: boolean;
};

export type VerdictKind = "first" | "extension" | "rewind" | "compaction" | "divergence";

export type Verdict = {
  kind: VerdictKind;
  /** Index of the first differing message, or the previous chain length for extensions. */
  index: number;
  /** Populated for "divergence": a short description of what moved. */
  detail?: string;
  /** Populated for "divergence": the first differing message's identity. */
  at?: { id: string; role: string };
};
