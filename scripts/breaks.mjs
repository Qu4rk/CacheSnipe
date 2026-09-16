#!/usr/bin/env node
/**
 * Prefix-break forensics.
 *
 * The plugin counts breaks from now on; this reconstructs them from the *past*
 * out of opencode's own store, so sessions that predate the plugin can still be
 * explained.
 *
 * The central measurement is **lost prefix**, not "big miss". Every turn must
 * upload its own new content (tool results, the user's message) uncached — that
 * is unavoidable and healthy. Waste is when a *previously cached* prefix has to
 * be re-sent:
 *
 *     lost(turn) = max(0, cache.read(turn-1) - cache.read(turn))
 *
 * A turn that resets to roughly system-prompt size (a "cold reset") additionally
 * means the whole chain was lost. Each wasteful turn is annotated with what
 * happened immediately before it — model or agent switch, skill activation, MCP
 * tool use, subtask dispatch, idle gap, local midnight — so a cause can be
 * pinned down or ruled out. It is correlation, not proof: the prompt itself is
 * not visible here.
 *
 * Usage:
 *   node scripts/breaks.mjs                       # 8 most recent DeepSeek sessions
 *   node scripts/breaks.mjs --recent 12 --verbose
 *   node scripts/breaks.mjs --session ses_abc
 *   node scripts/breaks.mjs --all-providers        # ignore the DeepSeek filter
 *   node scripts/breaks.mjs --by-provider          # only the aggregate table
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const has = (name) => args.includes(name);

if (has("--help") || has("-h")) {
  console.log(
    "usage: breaks.mjs [--session <id>] [--recent <n>] [--db <path>] [--all-providers] [--by-provider] [--verbose]",
  );
  process.exit(0);
}

const dbPath = flag("--db", join(homedir(), ".local", "share", "opencode", "opencode.db"));
const recent = Number(flag("--recent", "8"));
const deepseekOnly = !has("--all-providers");
const verbose = has("--verbose");
const byProviderOnly = has("--by-provider");
const sessionArg = flag("--session");
const LOSS_THRESHOLD = Number(flag("--loss-threshold", "2000"));
const COLD_RESET_CEILING = 6000;
const COLD_RESET_PREVIOUS = 20000;

if (!existsSync(dbPath)) {
  console.error(`opencode database not found: ${dbPath}`);
  process.exit(2);
}

const query = (sql) => {
  const out = execFileSync("sqlite3", ["-readonly", "-json", dbPath, sql], {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  const text = out.trim();
  return text.length === 0 ? [] : JSON.parse(text);
};

const sessions = query(`
  select session_id, count(*) messages, min(time_created) first, max(time_created) last
  from message
  where json_extract(data,'$.role') = 'assistant'
    ${deepseekOnly ? "and json_extract(data,'$.modelID') like '%deepseek%'" : ""}
    ${sessionArg ? `and session_id = '${sessionArg.replace(/'/g, "''")}'` : ""}
  group by session_id
  order by max(time_created) desc
  limit ${sessionArg ? 1 : recent}
`);

if (sessions.length === 0) {
  console.error(deepseekOnly ? "no DeepSeek sessions found (try --all-providers)" : "no sessions found");
  process.exit(2);
}

const num = (value) => Number(value) || 0;
const stamp = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
const localDay = (ms) => new Date(ms).toDateString();
const tokens = (value) => value.toLocaleString("en-US");

const causes = new Map();
const bump = (cause) => causes.set(cause, (causes.get(cause) ?? 0) + 1);

const providers = new Map();
const providerKey = (turn) => `${turn.providerID}/${turn.modelID}`;

const detail = [];

for (const session of sessions) {
  const id = session.session_id;
  const turns = query(`
    select id, time_created, json_extract(data,'$.providerID') providerID,
           json_extract(data,'$.modelID') modelID, json_extract(data,'$.mode') agent,
           coalesce(json_extract(data,'$.tokens.cache.read'),0) cacheRead,
           coalesce(json_extract(data,'$.tokens.input'),0) miss,
           coalesce(json_extract(data,'$.tokens.output'),0) output,
           json_extract(data,'$.summary') summary
    from message
    where session_id = '${id}' and json_extract(data,'$.role') = 'assistant'
    order by time_created asc
  `);

  const toolParts = query(`
    select time_created, json_extract(data,'$.tool') tool, json_extract(data,'$.state.input') input
    from part
    where session_id = '${id}' and json_extract(data,'$.type') = 'tool'
    order by time_created asc
  `);

  const events = [];
  let lost = 0;
  let billedInput = 0;
  let coldResets = 0;

  turns.forEach((turn, index) => {
    const cacheRead = num(turn.cacheRead);
    const miss = num(turn.miss);
    const previous = turns[index - 1];
    const previousCache = previous ? num(previous.cacheRead) : 0;
    const previousMiss = previous ? num(previous.miss) : 0;
    billedInput += miss + cacheRead;

    const stats = providers.get(providerKey(turn)) ?? { sessions: new Set(), turns: 0, cacheRead: 0, miss: 0, lost: 0, coldResets: 0 };
    stats.sessions.add(id);
    stats.turns += 1;
    stats.cacheRead += cacheRead;
    stats.miss += miss;

    if (index === 0) {
      providers.set(providerKey(turn), stats);
      return;
    }

    const wasLost = Math.max(0, previousCache - cacheRead);
    lost += wasLost;
    stats.lost += wasLost;

    const coldReset = cacheRead < COLD_RESET_CEILING && previousCache > COLD_RESET_PREVIOUS;
    if (coldReset) {
      coldResets += 1;
      stats.coldResets += 1;
    }
    providers.set(providerKey(turn), stats);

    const wasteful = wasLost >= LOSS_THRESHOLD || coldReset;
    const flags = [];
    if (previous.providerID !== turn.providerID || previous.modelID !== turn.modelID) {
      flags.push(`model-switch ${previous.providerID}/${previous.modelID} -> ${turn.providerID}/${turn.modelID}`);
    }
    if (previous.agent !== turn.agent) flags.push(`agent-switch ${previous.agent} -> ${turn.agent}`);
    if (localDay(previous.time_created) !== localDay(turn.time_created)) flags.push("local-midnight");
    const gap = turn.time_created - previous.time_created;
    if (gap > 30 * 60 * 1000) flags.push(`idle-gap ${Math.round(gap / 60000)}min`);
    if (turn.summary) flags.push("compaction-summary");

    const between = toolParts.filter(
      (part) => part.time_created >= previous.time_created && part.time_created <= turn.time_created,
    );
    const toolNames = new Set(between.map((part) => part.tool));
    if (toolNames.has("skill")) {
      const names = between
        .filter((part) => part.tool === "skill")
        .map((part) => {
          try {
            return JSON.parse(part.input ?? "{}").name ?? "?";
          } catch {
            return "?";
          }
        });
      flags.push(`skill-activated ${[...new Set(names)].join("+")}`);
    }
    const mcpTools = [...toolNames].filter((name) => typeof name === "string" && name.includes("_"));
    if (mcpTools.length > 0) flags.push(`mcp-tool ${mcpTools.join("+")}`);
    if (toolNames.has("task")) flags.push("subtask-dispatched");
    if (toolNames.has("invalid")) flags.push("invalid-tool-call");
    if (toolNames.has("edit") || toolNames.has("write")) flags.push("file-edit");
    if (previousMiss > 20000) flags.push(`previous-turn-was-large ${tokens(previousMiss)} tok`);

    if (!wasteful) return;

    if (coldReset) bump("cold-reset (whole chain lost)");
    else bump(`partial-loss (~${tokens(wasLost)} tok re-sent)`);

    const context = flags.length === 0 ? ["no-context-change-detected"] : flags;
    for (const entry of context) bump(`  with: ${entry.split(" ")[0]}`);

    events.push(
      `    turn ${String(index + 1).padStart(3)}  lost ${String(wasLost).padStart(7)}  cache ${String(cacheRead).padStart(8)}  ` +
        `miss ${String(miss).padStart(7)}  ${stamp(turn.time_created)}  ${coldReset ? "COLD-RESET " : ""}${context.join(" | ")}`,
    );
  });

  const warmTurns = turns.slice(1);
  const warmRead = warmTurns.reduce((sum, turn) => sum + num(turn.cacheRead), 0);
  const warmMiss = warmTurns.reduce((sum, turn) => sum + num(turn.miss), 0);
  const warmRate = warmRead + warmMiss === 0 ? 0 : warmRead / (warmRead + warmMiss);

  detail.push(
    `\n${id}  (${turns.length} turns, ${stamp(session.first)} -> ${stamp(session.last)}, provider(s) ` +
      `${[...new Set(turns.map(providerKey))].join(" + ")})`,
    `  warm hit rate ${(warmRate * 100).toFixed(1)}%  |  lost prefix ${tokens(lost)} tok ` +
      `(${((lost / Math.max(1, billedInput)) * 100).toFixed(1)}% of billed input)  |  ${coldResets} cold reset(s)`,
    ...(events.length > 0 ? events : ["    no wasteful turns detected"]),
  );
}

console.log("=== per provider (analysed sessions) ===");
console.log(
  "  providerID/modelID                                 sessions  turns  warm-hit  lost-tok  waste%  cold-resets",
);
const rows = [...providers.entries()].sort((a, b) => b[1].lost - a[1].lost);
for (const [key, stats] of rows) {
  const billed = stats.cacheRead + stats.miss;
  const warm = billed === 0 ? 0 : stats.cacheRead / billed;
  console.log(
    `  ${key.padEnd(48).slice(0, 48)}  ${String(stats.sessions.size).padStart(8)}  ${String(stats.turns).padStart(5)}  ` +
      `${(warm * 100).toFixed(1).padStart(7)}%  ${tokens(stats.lost).padStart(8)}  ` +
      `${((stats.lost / Math.max(1, billed)) * 100).toFixed(1).padStart(6)}%  ${String(stats.coldResets).padStart(11)}`,
  );
}

if (!byProviderOnly) {
  console.log("\n=== per session ===");
  console.log(detail.join("\n"));
}

console.log("\n=== attributed causes (turns with wasted prefix) ===");
if (causes.size === 0) console.log("  (none)");
for (const [cause, count] of [...causes.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}×  ${cause}`);
}
console.log(
  "\n  reminder: `with: no-context-change-detected` means the prefix moved for a reason this tool cannot see" +
    "\n  (provider-side cache eviction or upstream routing, a different tool set, or a system-prompt change).",
);
