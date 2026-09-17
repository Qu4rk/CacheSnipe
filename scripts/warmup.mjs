#!/usr/bin/env node
/**
 * warmup — opt-in explicit DeepSeek disk-cache warm-up for one session.
 *
 * Best-effort: replays the session's persisted baseline blocks (env, skills,
 * mcp, references) as the system prefix and sends the same tiny request twice.
 * Per https://api-docs.deepseek.com/guides/kv_cache, the first send persists
 * end-of-input units and the repeat verifies the hit; common-prefix detection
 * then lets the next real turn match those units as its prefix.
 *
 * The plugin never calls this from hooks (no secret handling in the hot path).
 * Run it manually after start/resume when `warmup: true`:
 *
 *   node scripts/warmup.mjs --session ses_abc123
 *   node scripts/warmup.mjs                            # most-recent session
 *   node scripts/warmup.mjs --session ses_abc123 --dry-run
 *   node scripts/warmup.mjs --session ses_abc123 --model deepseek-v4-flash --settle 4000
 *
 * Credential: $DEEPSEEK_API_KEY, else the `deepseek` entry in opencode's auth.json.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AUTH_PATH = join(homedir(), ".local", "share", "opencode", "auth.json");
const DEFAULT_STATS = join(homedir(), ".local", "share", "opencode", "deepseek-cache");
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_BASE = "https://api.deepseek.com";

function parseArgs(argv) {
  const opts = { session: undefined, model: DEFAULT_MODEL, base: DEFAULT_BASE, statsDir: DEFAULT_STATS, settle: 4000, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === "--session" || arg === "-s") opts.session = next();
    else if (arg === "--model" || arg === "-m") opts.model = next();
    else if (arg === "--base") opts.base = next();
    else if (arg === "--stats-dir") opts.statsDir = next();
    else if (arg === "--settle") opts.settle = Number(next());
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`unknown flag: ${arg}`);
  }
  if (!opts.help && !opts.session) {
    const latest = latestSession(opts.statsDir);
    if (!latest) throw new Error(`no sessions in ${opts.statsDir}/sessions — send one real turn first`);
    opts.session = latest;
  }
  return opts;
}

function loadKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const auth = JSON.parse(readFileSync(AUTH_PATH, "utf8"));
    const entry = auth?.deepseek;
    const key = typeof entry === "string" ? entry : entry?.key;
    if (typeof key === "string" && key.length > 0) return key;
  } catch { /* fall through */ }
  throw new Error(`no DeepSeek credential (set DEEPSEEK_API_KEY or add "deepseek" to ${AUTH_PATH})`);
}

function loadSession(statsDir, sessionID) {
  const file = join(statsDir, "sessions", `${sessionID}.json`);
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Most-recently-updated session id, so the agent can warm without knowing ids. */
export function latestSession(statsDir) {
  let dir;
  try {
    dir = readdirSync(join(statsDir, "sessions")).filter((name) => name.endsWith(".json"));
  } catch {
    return undefined;
  }
  let best;
  let bestMtime = -1;
  for (const name of dir) {
    try {
      const mtime = statSync(join(statsDir, "sessions", name)).mtimeMs;
      if (mtime > bestMtime) {
        bestMtime = mtime;
        best = name.slice(0, -".json".length);
      }
    } catch { /* skip unreadable entries */ }
  }
  return best;
}

function buildPrefix(session) {
  const blocks = session?.baselineBlocks ?? session?.frozenBlocks ?? {};
  const order = ["env", "skills", "mcp", "references"];
  const parts = [];
  for (const name of order) {
    if (typeof blocks[name] === "string" && blocks[name].length > 0) parts.push(blocks[name]);
  }
  const date = typeof session?.frozenDate === "string" && session.frozenDate ? `\nSession-start date (frozen): ${session.frozenDate}` : "";
  const cwd = session?.frozenCwd ? `\nSession-start cwd (frozen): ${session.frozenCwd.working} / ${session.frozenCwd.root}` : "";
  const prefix = [...parts, date, cwd].filter(Boolean).join("\n----\n");
  return prefix.length > 0 ? prefix : undefined;
}

async function callOnce({ base, key, model, messages }) {
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 8, stream: false }),
    signal: AbortSignal.timeout(120000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} — ${text.replace(/\s+/g, " ").slice(0, 200)}`);
  const body = JSON.parse(text);
  const usage = body.usage ?? {};
  const hit = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
  const miss = usage.prompt_cache_miss_tokens ?? (usage.prompt_tokens ?? 0) - hit;
  return { hit, miss, promptTokens: usage.prompt_tokens ?? hit + miss };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0].replace(/^\/\*\*?/, ""));
    return;
  }
  const session = loadSession(opts.statsDir, opts.session);
  const prefix = buildPrefix(session);
  if (!prefix) {
    console.error(`no baseline blocks for session ${opts.session} — send one real turn first`);
    process.exitCode = 1;
    return;
  }
  const messages = [
    { role: "system", content: prefix },
    { role: "user", content: "CacheSnipe warmup ping. Reply with exactly: warm" },
  ];
  if (opts.dryRun) {
    console.log(`dry-run: would send 2 pings for ${opts.session} (system ${prefix.length} chars)`);
    return;
  }
  const key = loadKey();
  console.log(`warmup ${opts.session} model=${opts.model} system=${prefix.length} chars`);
  const first = await callOnce({ base: opts.base, key, model: opts.model, messages });
  console.log(`  ping1 prompt=${first.promptTokens} hit=${first.hit} miss=${first.miss}`);
  await sleep(opts.settle);
  const second = await callOnce({ base: opts.base, key, model: opts.model, messages });
  console.log(`  ping2 prompt=${second.promptTokens} hit=${second.hit} miss=${second.miss}`);
  const ratio = second.promptTokens > 0 ? ((second.hit / second.promptTokens) * 100).toFixed(1) : "n/a";
  console.log(`  warm verify: ${ratio}% hit on repeat ping`);
}

main().catch((error) => {
  console.error(`warmup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
