#!/usr/bin/env node
/**
 * Independent verification.
 *
 * Reads opencode's own SQLite store (`message.data` holds `tokens.cache.read`,
 * miss `input` and `cost` per assistant message) so the measured hit rate does
 * not depend on the plugin's own bookkeeping. Then it cross-checks the plugin's
 * per-session JSON and fails if the two disagree.
 *
 * Usage:
 *   node scripts/verify.mjs                          # newest DeepSeek session
 *   node scripts/verify.mjs --session ses_abc
 *   node scripts/verify.mjs --directory /path/to/project
 *   node scripts/verify.mjs --min-hit 0.9 --json
 *
 * Exit code 0 = every assertion held.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);

function flag(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function has(name) {
  return args.includes(name);
}

const dbPath = flag("--db") ?? join(homedir(), ".local", "share", "opencode", "opencode.db");
const statsDir = flag("--stats-dir") ?? join(homedir(), ".local", "share", "opencode", "deepseek-cache");
const explicitSession = flag("--session");
const explicitDirectory = flag("--directory");
const minHit = Number(flag("--min-hit") ?? "0.9");
const minHitEnforced = flag("--min-hit") !== undefined;
const asJson = has("--json");
const wantsHelp = has("--help") || has("-h");

if (wantsHelp) {
  console.log(`CacheSnipe verification

  --session <id>       verify one session id
  --directory <path>   verify the newest session in that directory
  --min-hit <ratio>    also require a warm hit rate (enforced only when passed;
                       agentic turns upload new content every turn, so the hit
                       rate is reported rather than required)
  --db <path>          opencode database (default ${dbPath})
  --stats-dir <path>   plugin stats directory (default ${statsDir})
  --json               print the raw result object
`);
  process.exit(0);
}

const failures = [];
const notes = [];

function fail(message) {
  failures.push(message);
}

function ok(message) {
  notes.push(message);
}

function query(sql) {
  const out = execFileSync("sqlite3", ["-readonly", "-json", dbPath, sql], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const text = out.trim();
  return text.length === 0 ? [] : JSON.parse(text);
}

if (!existsSync(dbPath)) {
  console.error(`opencode database not found: ${dbPath}`);
  console.error("Pass --db <path> or run a session first.");
  process.exit(2);
}

const projection = (where) => `
  select
    m.session_id                                                              as sessionID,
    m.id                                                                      as messageID,
    json_extract(m.data, '$.time.created')                                    as createdAt,
    json_extract(m.data, '$.providerID')                                      as providerID,
    json_extract(m.data, '$.modelID')                                         as modelID,
    coalesce(json_extract(m.data, '$.tokens.input'), 0)                       as missInput,
    coalesce(json_extract(m.data, '$.tokens.cache.read'), 0)                  as cacheRead,
    coalesce(json_extract(m.data, '$.tokens.cache.write'), 0)                 as cacheWrite,
    coalesce(json_extract(m.data, '$.tokens.output'), 0)                      as output,
    coalesce(json_extract(m.data, '$.cost'), 0)                               as cost,
    -- Tool output this turn produced: it becomes the *next* request's new content,
    -- which is the bulk of that request's unavoidable miss input.
    (select coalesce(sum(length(coalesce(json_extract(p.data, '$.state.output'), ''))), 0)
       from part p
      where p.message_id = m.id
        and json_extract(p.data, '$.type') = 'tool')                            as toolOutputBytes
  from message m
  where json_extract(m.data, '$.role') = 'assistant'
    -- an aborted request still lands as an assistant message but has no usage:
    -- counting it invents a fake cold turn with a huge lost-prefix number
    and json_extract(m.data, '$.error') is null
    and ${where}
  order by m.time_created asc
`;

let rows = [];
let selection = "";

if (explicitSession) {
  selection = `session ${explicitSession}`;
  rows = query(projection(`m.session_id = '${explicitSession.replace(/'/g, "''")}'`));
} else if (explicitDirectory) {
  selection = `newest session in ${explicitDirectory}`;
  rows = query(
    projection(`m.session_id = (
      select s.id from session s
      where s.directory = '${explicitDirectory.replace(/'/g, "''")}'
      order by s.time_updated desc limit 1)`),
  );
} else {
  selection = "newest DeepSeek session";
  rows = query(
    projection(`m.session_id = (
      select session_id from message
      where json_extract(data, '$.role') = 'assistant'
        and json_extract(data, '$.providerID') = 'deepseek'
      order by time_created desc limit 1)`),
  );
}

if (rows.length === 0) {
  console.error(`No assistant messages found for: ${selection}`);
  console.error("Use --session/--directory, or run a DeepSeek session first.");
  process.exit(2);
}

const sessionID = rows[0].sessionID;
const model = `${rows[0].providerID}/${rows[0].modelID}`;
if (rows[0].providerID !== "deepseek") {
  notes.push(`this session ran on ${model}, not the official DeepSeek API — numbers are still measured from the database`);
}
const turns = rows.map((row, index) => ({
  turn: index + 1,
  cacheRead: Number(row.cacheRead) || 0,
  missInput: Number(row.missInput) || 0,
  cacheWrite: Number(row.cacheWrite) || 0,
  output: Number(row.output) || 0,
  cost: Number(row.cost) || 0,
  toolOutputBytes: Number(row.toolOutputBytes) || 0,
  hitRate: (Number(row.cacheRead) || 0) / ((Number(row.cacheRead) || 0) + (Number(row.missInput) || 0) || 1),
}));

// `lost` is the honest prefix-health measure: how much *previously cached* prefix
// had to be uploaded again. Reads grow when the chain is intact, so lost === 0
// across the session means the prefix was never re-sent. Miss input alone cannot
// tell the difference between a broken prefix and a turn that simply added new
// content, which is why it is not the pass criterion.
for (let index = 1; index < turns.length; index += 1) {
  const previous = turns[index - 1];
  const turn = turns[index];
  turn.lost = Math.max(0, previous.cacheRead - turn.cacheRead);
  turn.retained = previous.cacheRead === 0 ? undefined : Math.min(1, turn.cacheRead / previous.cacheRead);
}

const warm = turns.filter((turn) => turn.turn > 1);
const warmRead = warm.reduce((sum, turn) => sum + turn.cacheRead, 0);
const warmMiss = warm.reduce((sum, turn) => sum + turn.missInput, 0);
const warmHit = warmRead + warmMiss === 0 ? 0 : warmRead / (warmRead + warmMiss);
const coldTurns = warm.filter((turn) => turn.cacheRead <= 0);

if (warm.length === 0) fail(`only one turn observed for ${sessionID}; run at least two turns to measure cache reuse`);
for (const turn of coldTurns) fail(`turn ${turn.turn} had cacheRead = 0 (prefix was not reused)`);

const lostTotal = warm.reduce((sum, turn) => sum + (turn.lost ?? 0), 0);
const lostTurns = warm.filter((turn) => (turn.lost ?? 0) > 0);
if (lostTurns.length > 0) {
  fail(
    `previously cached prefix was re-sent: turns ${lostTurns.map((turn) => turn.turn).join(", ")}` +
      ` (${lostTotal} tokens; the chain broke, which is the thing this plugin exists to prevent)`,
  );
} else if (warm.length > 0) {
  ok(`prefix retained on every warm turn: 0 tokens of cached prefix re-sent (${warm.length} turns)`);
}

if (minHitEnforced && warmHit < minHit) {
  fail(`warm hit rate ${(warmHit * 100).toFixed(1)}% is below the requested ${(minHit * 100).toFixed(0)}%`);
} else if (!minHitEnforced) {
  notes.push(
    `warm hit rate ${(warmHit * 100).toFixed(1)}% (informational): each agentic turn also uploads its own new` +
      ` content — tool output plus your message — which is unavoidable and lands in miss input`,
  );
}

const pluginFile = join(statsDir, "sessions", `${sessionID}.json`);
let pluginStats;
if (existsSync(pluginFile)) {
  try {
    pluginStats = JSON.parse(readFileSync(pluginFile, "utf8"));
  } catch (error) {
    fail(`plugin stats file is unreadable: ${error.message}`);
  }
} else {
  notes.push(`no plugin stats file at ${pluginFile} (plugin not installed, or this session predates it)`);
}

if (pluginStats) {
  const dbRead = turns.reduce((sum, turn) => sum + turn.cacheRead, 0);
  const dbMiss = turns.reduce((sum, turn) => sum + turn.missInput, 0);
  const dbTurns = turns.length;
  // Older plugin builds counted aborted (zero-usage) assistant messages as turns,
  // so the stored `turns` can exceed the history length. The record itself tells
  // us how big that skew can be; tolerate exactly it instead of failing a healthy
  // session. New builds (turn = a message that delivered usage) have skew 0.
  const phantomTurns = Math.max(0, (pluginStats.turns ?? 0) - (pluginStats.history?.length ?? 0));
  const drift = (a, b) => (Math.max(a, b) === 0 ? 0 : Math.abs(a - b) / Math.max(a, b));
  const checks = [
    ["cacheRead", pluginStats.cacheRead ?? 0, dbRead],
    ["missInput", pluginStats.missInput ?? 0, dbMiss],
  ];
  for (const [name, pluginValue, dbValue] of checks) {
    if (drift(pluginValue, dbValue) > 0.01) {
      fail(`plugin ${name} (${pluginValue}) disagrees with the database (${dbValue}) by more than 1%`);
    }
  }
  if (Math.abs((pluginStats.turns ?? 0) - dbTurns) > phantomTurns) {
    fail(`plugin turns (${pluginStats.turns}) disagrees with the database (${dbTurns})`);
  } else if (phantomTurns > 0 && Math.abs((pluginStats.turns ?? 0) - dbTurns) > 0) {
    notes.push(
      `plugin turns (${pluginStats.turns}) is ${Math.abs((pluginStats.turns ?? 0) - dbTurns)} above the database (${dbTurns}) —` +
        ` within the ${phantomTurns} phantom turn(s) an older build counted for aborted requests`,
    );
  }
  if ((pluginStats.prefixBreaks ?? 0) !== 0) fail(`plugin counted ${pluginStats.prefixBreaks} prefix break(s)`);
  if ((pluginStats.systemPromptBreaks ?? 0) !== 0) {
    fail(`plugin counted ${pluginStats.systemPromptBreaks} system prompt break(s)`);
  }
  if ((pluginStats.prefixBreaks ?? 0) === 0 && (pluginStats.systemPromptBreaks ?? 0) === 0) {
    ok("prefixBreaks == 0 and systemPromptBreaks == 0");
  }
  if (pluginStats.frozenDate) ok(`frozen date: ${pluginStats.frozenDate}`);
}

const bar = (rate) => {
  const filled = Math.round(Math.max(0, Math.min(1, rate)) * 24);
  return `${"█".repeat(filled)}${"░".repeat(24 - filled)}`;
};

if (asJson) {
  console.log(
    JSON.stringify(
      { sessionID, model, turns, warmHit, minHit, minHitEnforced, lostTotal, pluginStats: pluginStats ?? null, failures, notes },
      null,
      2,
    ),
  );
} else {
console.log("CacheSnipe verification");
console.log(`${selection}`);
console.log(`session ${sessionID}   model ${model}`);
  console.log("");
  console.log("  turn     hit%   cache read      miss input        lost   prev tool out         cost   ");
  for (const turn of turns) {
    const previousTurn = turns[turn.turn - 2];
    console.log(
      `  ${String(turn.turn).padStart(4)}  ${(turn.hitRate * 100).toFixed(1).padStart(6)}%  ` +
        `${String(turn.cacheRead).padStart(11)}  ${String(turn.missInput).padStart(11)}  ` +
        `${String(turn.lost ?? 0).padStart(7)}  ${String(previousTurn ? previousTurn.toolOutputBytes : 0).padStart(13)}  ` +
        `${turn.cost.toFixed(6).padStart(9)}`,
    );
  }
  console.log("");
  console.log(`  prefix lost (turns 2+)    ${lostTotal} tokens  ${lostTotal === 0 ? "(the whole prior prefix came back from cache)" : "(re-sent — investigate)"}`);
  console.log(`  warm hit rate (turns 2+)  ${(warmHit * 100).toFixed(1)}%  ${bar(warmHit)}  ${minHitEnforced ? `target ${(minHit * 100).toFixed(0)}%` : "informational"}`);
  if (pluginStats) {
    console.log(
      `  plugin stats              turns ${pluginStats.turns}  breaks ${pluginStats.prefixBreaks}/${pluginStats.systemPromptBreaks}  ` +
        `rewinds ${pluginStats.rewinds}  compactions ${pluginStats.compactions}`,
    );
  }
  console.log("");
  for (const note of notes) console.log(`  ok    ${note}`);
  for (const failure of failures) console.log(`  FAIL  ${failure}`);
  console.log("");
  console.log(failures.length === 0 ? "RESULT: pass" : `RESULT: fail (${failures.length})`);
}

if (pluginStats) {
  // Surfacing the stats directory contents helps when a run looks wrong.
  try {
    const files = readdirSync(join(statsDir, "sessions")).length;
    if (!asJson && files > 1) console.log(`  note  ${files} session records in ${statsDir}/sessions`);
  } catch {
    // Directory missing is already reported above.
  }
}

process.exit(failures.length === 0 ? 0 : 1);
