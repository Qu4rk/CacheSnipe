import { estimateSavings, estimateUncached, formatTokens, formatUsd, type PriceTable } from "./prices.js";
import type { SessionStats, TurnPoint } from "./types.js";

/**
 * Pure renderers for the two files the `/cache-stats` and `/cache-graph`
 * commands `cat` into the prompt. Kept free of I/O so they can be unit tested
 * and so the commands stay dumb (inject file contents, print verbatim).
 */

export type ConfigSnapshot = {
  prune?: boolean | undefined;
  compactionModel?: string | undefined;
  compactionTemperature?: number | undefined;
  smallModel?: string | undefined;
  strictFreeze?: boolean | undefined;
  notifications?: boolean | undefined;
  opencodeVersion?: string | undefined;
  capturedAt?: number | undefined;
};

const BAR_WIDTH = 30;

function bar(rate: number, width = BAR_WIDTH): string {
  const clamped = Math.max(0, Math.min(1, rate));
  const filled = Math.round(clamped * width);
  return `${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}`;
}

export function hitRateOf(stats: Pick<SessionStats, "cacheRead" | "missInput">): number {
  const denom = stats.cacheRead + stats.missInput;
  return denom === 0 ? 0 : stats.cacheRead / denom;
}

/** Hit rate over turns 2+ only: turn 1 is cold by definition and must not dent the target. */
export function warmHitRate(history: TurnPoint[]): number {
  const warm = history.filter((point) => point.turn > 1);
  if (warm.length === 0) return 0;
  let read = 0;
  let miss = 0;
  for (const point of warm) {
    read += point.cacheRead;
    miss += point.missInput;
  }
  const denom = read + miss;
  return denom === 0 ? 0 : read / denom;
}

/**
 * Tokens of previously cached prefix that had to be uploaded again: the honest
 * prefix-health measure. Every turn also sends its own new content (tool output,
 * your message), which is miss input no matter how perfect the prefix is, so a hit
 * rate alone cannot tell a broken chain from a healthy agentic turn. Reads grow
 * while the chain is intact, so this stays 0.
 */
export function prefixLost(history: TurnPoint[]): number {
  let lost = 0;
  for (let index = 1; index < history.length; index += 1) {
    lost += Math.max(0, (history[index - 1]?.cacheRead ?? 0) - (history[index]?.cacheRead ?? 0));
  }
  return lost;
}

export function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function trendLines(stats: SessionStats): string[] {
  const lines: string[] = [];
  for (const point of stats.history.slice(-20)) {
    const cold = point.turn === 1 ? "  cold (first request of the session)" : "";
    lines.push(
      `  ${String(point.turn).padStart(3)}  ${pct(point.hitRate).padStart(6)}  ${bar(point.hitRate)} ${cold}`,
    );
  }
  return lines.length > 0 ? lines : ["  (no turns recorded yet)"];
}

function sessionSection(
  stats: SessionStats,
  price: ReturnType<PriceTable["get"]>,
  config: ConfigSnapshot | undefined,
): string[] {
  const usage = {
    input: stats.missInput,
    output: stats.output,
    reasoning: stats.reasoning,
    cacheRead: stats.cacheRead,
    cacheWrite: stats.cacheWrite,
    cost: stats.cost,
  };
  const uncached = estimateUncached(price, usage);
  const saved = estimateSavings(price, stats.cacheRead);
  const savingsPct = uncached > 0 ? (saved / uncached) * 100 : 0;
  const warm = warmHitRate(stats.history);
  const lost = prefixLost(stats.history);
  const lines: string[] = [
    `this session  ${stats.sessionID}  ${stats.providerID}/${stats.modelID}`,
    `  turns                 ${stats.turns} assistant messages / ${stats.requests} requests`,
    `  hit rate (turns 2+)   ${warm === 0 && stats.history.length <= 1 ? "n/a (single turn so far)" : pct(warm)}   ${bar(warm)}`,
    `  prefix lost (turns 2+) ${formatTokens(lost)} tok   ${lost === 0 ? "chain intact (no cached prefix re-sent)" : "cached prefix was re-sent; check the breaks below"}`,
    `                        (hit rate excludes each turn's own new content, which cannot be cached)` ,
    `  cache read            ${formatTokens(stats.cacheRead)} tok  @ ${price ? `$${price.cacheRead}/1M` : "unknown price"}`,
    `  miss input            ${formatTokens(stats.missInput)} tok  @ ${price ? `$${price.input}/1M` : "unknown price"}`,
    `  cache write           ${formatTokens(stats.cacheWrite)} tok`,
    `  output                ${formatTokens(stats.output)} tok   reasoning ${formatTokens(stats.reasoning)} tok`,
    `  reported cost         ${formatUsd(stats.cost)}`,
    `  if nothing had cached ${formatUsd(uncached)}   ->   est. saved ${formatUsd(saved)} (${savingsPct.toFixed(0)}%)`,
    `  prefix breaks         ${stats.prefixBreaks}`,
    `  system prompt breaks  ${stats.systemPromptBreaks}`,
    `  rewinds               ${stats.rewinds}    compactions ${stats.compactions}`,
    `  frozen date           ${stats.frozenDate || "(not set)"}`,
    `  prompt hash           ${stats.promptHash || "(none)"}`,
    `  blocks                ${Object.entries(stats.blocks)
      .map(([name, hash]) => `${name}=${hash === "none" ? "none" : hash.slice(0, 8)}`)
      .join(" ") || "(none)"}`,
    `  first turn at         ${new Date(stats.createdAt).toISOString()}`,
  ];
  const notes = stats.notes.slice(-6);
  lines.push(`  break causes          ${notes.length === 0 ? "none" : ""}`);
  for (const note of notes) lines.push(`    - ${note}`);
  if (config) {
    lines.push("");
    lines.push("config snapshot");
    lines.push(
      `  compaction.prune      ${config.prune === false ? "false (good: pruning rewrites old tool outputs mid-history)" : String(config.prune)}`,
    );
    if (config.prune !== false) {
      lines.push("                        WARNING: prune is not disabled; it busts the prefix mid-session.");
    }
    lines.push(
      `  compaction agent      ${config.compactionModel ?? "(unset)"} @ temp ${config.compactionTemperature ?? "(unset)"}`,
    );
    lines.push(`  small_model           ${config.smallModel ?? "(unset)"}`);
    lines.push(
      `  plugin options        strictFreeze=${config.strictFreeze === true} notifications=${config.notifications === true}`,
    );
  }
  return lines;
}

export function renderSummary(input: {
  current: SessionStats | undefined;
  sessions: SessionStats[];
  priceTable: PriceTable;
  config?: ConfigSnapshot | undefined;
  now?: number;
}): string {
  const now = input.now ?? Date.now();
  const lines: string[] = [
    "CacheSnipe: DeepSeek prompt-cache report",
    `generated ${new Date(now).toISOString()}`,
    "",
  ];

  if (input.current) {
    lines.push(...sessionSection(input.current, input.priceTable.get(input.current.providerID, input.current.modelID), input.config));
    lines.push("");
    lines.push(`trend (last ${Math.min(20, input.current.history.length)} turns)`);
    lines.push(...trendLines(input.current));
    lines.push("");
  } else {
    lines.push("this session  (not a DeepSeek session, or nothing observed yet)");
    lines.push("");
  }

  const withUsage = input.sessions.filter((session) => session.turns > 0);
  const read = withUsage.reduce((sum, session) => sum + session.cacheRead, 0);
  const miss = withUsage.reduce((sum, session) => sum + session.missInput, 0);
  const cost = withUsage.reduce((sum, session) => sum + session.cost, 0);
  const saved = withUsage.reduce(
    (sum, session) => sum + estimateSavings(input.priceTable.get(session.providerID, session.modelID), session.cacheRead),
    0,
  );
  const dirs = new Set(withUsage.map((session) => session.directory));
  const breaks = withUsage.reduce((sum, session) => sum + session.prefixBreaks, 0);
  const promptBreaks = withUsage.reduce((sum, session) => sum + session.systemPromptBreaks, 0);
  const compactions = withUsage.reduce((sum, session) => sum + session.compactions, 0);
  const denom = read + miss;

  lines.push(`across ${withUsage.length} session(s) in ${dirs.size} directory(ies)  [${input.priceTable.origin}]`);
  lines.push(`  cache read            ${formatTokens(read)} tok`);
  lines.push(`  miss input            ${formatTokens(miss)} tok`);
  lines.push(`  blended hit rate      ${pct(denom === 0 ? 0 : read / denom)}   ${bar(denom === 0 ? 0 : read / denom)}`);
  lines.push(`  reported cost         ${formatUsd(cost)}`);
  lines.push(`  est. saved            ${formatUsd(saved)}`);
  lines.push(`  breaks                prefix ${breaks} / system prompt ${promptBreaks} / compactions ${compactions}`);
  lines.push("");
  lines.push("sessions (newest first)");

  const ordered = [...withUsage].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12);
  if (ordered.length === 0) lines.push("  (none yet)");
  for (const session of ordered) {
    lines.push(
      `  ${session.sessionID}  ${String(session.turns).padStart(3)} turns  ${pct(warmHitRate(session.history)).padStart(6)}  ` +
        `breaks ${session.prefixBreaks}/${session.systemPromptBreaks}  ${session.providerID}/${session.modelID}  ${session.directory}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function renderGraph(input: {
  current: SessionStats | undefined;
  sessions: SessionStats[];
  priceTable: PriceTable;
  now?: number;
}): string {
  const now = input.now ?? Date.now();
  const lines: string[] = ["CacheSnipe: cache-hit trend", `generated ${new Date(now).toISOString()}`, ""];

  if (input.current) {
    lines.push(`session ${input.current.sessionID} (${input.current.providerID}/${input.current.modelID})`);
    lines.push("  turn     hit%  cache read      miss input        cost   ");
    for (const point of input.current.history.slice(-24)) {
      lines.push(
        `  ${String(point.turn).padStart(4)}  ${pct(point.hitRate).padStart(6)}  ` +
          `${formatTokens(point.cacheRead).padStart(11)}  ${formatTokens(point.missInput).padStart(11)}  ${formatUsd(point.cost).padStart(9)}`,
      );
    }
    if (input.current.history.length === 0) lines.push("  (no turns recorded yet)");
    lines.push("");
    lines.push("  hit-rate bars");
    for (const point of input.current.history.slice(-24)) {
      lines.push(`  ${String(point.turn).padStart(4)}  ${bar(point.hitRate, 24)} ${pct(point.hitRate)}`);
    }
    lines.push("");
  } else {
    lines.push("session (not a DeepSeek session, or nothing observed yet)");
    lines.push("");
  }

  const ordered = [...input.sessions]
    .filter((session) => session.turns > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 12);
  lines.push("recent sessions (warm hit rate, turns 2+)");
  if (ordered.length === 0) lines.push("  (none yet)");
  for (const session of ordered) {
    const rate = warmHitRate(session.history);
    lines.push(`  ${session.sessionID}  ${bar(rate, 20)} ${pct(rate).padStart(6)}  ${session.turns} turns`);
  }
  lines.push("");
  lines.push("legend: turns 1 is always cold (nothing cached yet); the target is >=90% from turn 2 onward.");
  return `${lines.join("\n")}\n`;
}
