#!/usr/bin/env node
/**
 * cache-probe — controlled cache experiment against the official DeepSeek API.
 *
 * Answers one question with evidence instead of inference: do `deepseek-v4-flash`
 * and `deepseek-v4-pro` cache identically?
 *
 * Method. Each model is sent a sequence of requests sharing a byte-identical,
 * stable prefix `P` (~4.7k tokens). The phases mirror the cases documented at
 * https://api-docs.deepseek.com/guides/kv_cache/:
 *
 *   cold         P  + Q1              first contact                expect: miss
 *   repeat       byte-identical       persisted end-of-input unit  expect: hit (near all)
 *   append       P + Q1 + A1 + Q2     normal multi-turn            expect: hit on P + Q1
 *   branch       P  + Q3              divergent tail, P seen before expect: hit on P
 *   fresh1       P2 + Q1              a second, unseen prefix       expect: miss
 *   fresh2       P2 + Q3              Example 2 exactly: A+B then A+C
 *
 * `fresh2` is the phase that actually tests the documented Example 2: a prefix
 * that has been sent only once, with a differing tail. `branch` runs after
 * repeats of P, so the shared prefix is already a persisted unit — a distinction
 * the first run of this probe made visible the hard way.
 *
 * A sleep between requests matters: the docs say "cache construction takes
 * seconds", so hitting a unit before it is persisted would read as a false miss.
 *
 * Usage:
 *   node scripts/cache-probe.mjs                 # both models, all phases
 *   node scripts/cache-probe.mjs --model deepseek-v4-pro
 *   node scripts/cache-probe.mjs --settle 8000   # slower, safer persistence
 *   node scripts/cache-probe.mjs --lines 200     # longer shared prefix
 *
 * Credential: $DEEPSEEK_API_KEY, else the `deepseek` entry in opencode's auth.json.
 * Nothing secret is printed.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro"];
const DEFAULT_BASE = "https://api.deepseek.com";
const AUTH_PATH = join(homedir(), ".local", "share", "opencode", "auth.json");
const MODELS_PATH = join(homedir(), ".cache", "opencode", "models.json");

/** ~36 tokens/line below, so 130 lines lands near 4.7k tokens. */
const DEFAULT_LINES = 130;
const SEED_A = 0x5eed1234;
const SEED_B = 0x1badc0de;

function parseArgs(argv) {
  const opts = { models: [], base: DEFAULT_BASE, settle: 4000, lines: DEFAULT_LINES, nonce: false, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === "--model" || arg === "-m") opts.models.push(next());
    else if (arg === "--base") opts.base = next();
    else if (arg === "--settle") opts.settle = Number(next());
    else if (arg === "--lines") opts.lines = Number(next());
    else if (arg === "--nonce") opts.nonce = true;
    else if (arg === "--quiet") opts.quiet = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`unknown flag: ${arg}`);
  }
  if (opts.models.length === 0) opts.models = [...DEFAULT_MODELS];
  return opts;
}

function loadKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const auth = JSON.parse(readFileSync(AUTH_PATH, "utf8"));
    const entry = auth?.deepseek;
    const key = typeof entry === "string" ? entry : entry?.key;
    if (typeof key === "string" && key.length > 0) return key;
  } catch {
    /* fall through to the error below */
  }
  throw new Error(`no DeepSeek credential (set DEEPSEEK_API_KEY or add "deepseek" to ${AUTH_PATH})`);
}

function loadPrice(modelID) {
  try {
    const models = JSON.parse(readFileSync(MODELS_PATH, "utf8"));
    const cost = models?.deepseek?.models?.[modelID]?.cost;
    if (!cost) return undefined;
    return { input: cost.input ?? 0, output: cost.output ?? 0, cacheRead: cost.cache_read ?? 0 };
  } catch {
    return undefined;
  }
}

/**
 * Deterministic filler. A seeded LCG (not Math.random) so all phases in a run share
 * byte-identical bytes — a prefix that changes between phases would invalidate the
 * experiment. `nonce` is the one exception: it salts the prefix so that a run's
 * "cold" phase is genuinely unseen, instead of hitting units a previous run left
 * on DeepSeek's disk cache (which is exactly what happened in the first run here).
 */
function buildPrefix(seed, lines, nonce) {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state;
  };
  const rows = [];
  for (let i = 1; i <= lines; i += 1) {
    const hex = next().toString(16).padStart(8, "0");
    const shard = `shard-${(next() % 64).toString(36).padStart(2, "0")}`;
    const region = ["eu-west-1", "us-east-2", "ap-south-1", "sa-east-1"][next() % 4];
    rows.push(
      `[row ${String(i).padStart(4, "0")}] region=${region} ${shard} checksum=${hex} ` +
        `status=nominal retries=${next() % 7} owner=team-${(next() % 23).toString(36)}`,
    );
  }
  return [
    "Operational log excerpt, retained verbatim for the whole experiment.",
    "Each row is one processed batch; ordering is significant.",
    nonce ? `run=${nonce} (fresh namespace)` : "run=deterministic",
    "",
    ...rows,
  ].join("\n");
}

function shortHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

const QUESTION_1 = "Reply with exactly one word: alpha";
const QUESTION_2 = "Reply with exactly one word: beta";
const QUESTION_3 = "Reply with exactly one word: gamma";

function formatTokens(value) {
  return typeof value === "number" ? value.toLocaleString("en-US") : "?";
}

async function callModel({ base, key, model, messages, timeoutMs = 120000 }) {
  const started = Date.now();
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 512, stream: false }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const elapsedMs = Date.now() - started;
  const text = await response.text();
  if (!response.ok) {
    const snippet = text.replace(/\s+/g, " ").slice(0, 400);
    throw new Error(`${model}: HTTP ${response.status} — ${snippet}`);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${model}: response was not JSON — ${text.slice(0, 200)}`);
  }
  const usage = body.usage ?? {};
  // OpenAI-compatible: prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens.
  const hit = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens;
  const miss =
    usage.prompt_cache_miss_tokens ?? (hit === undefined ? undefined : (usage.prompt_tokens ?? 0) - hit);
  const choice = body.choices?.[0];
  return {
    promptTokens: usage.prompt_tokens,
    hit,
    miss,
    completionTokens: usage.completion_tokens,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens,
    thinking: typeof choice?.message?.reasoning_content === "string" && choice.message.reasoning_content.length > 0,
    content: typeof choice?.message?.content === "string" ? choice.message.content.trim() : "",
    finishReason: choice?.finish_reason,
    elapsedMs,
  };
}

function costOf(price, usage) {
  if (!price || usage.promptTokens === undefined) return undefined;
  const hit = usage.hit ?? 0;
  const miss = usage.miss ?? 0;
  return (
    (miss / 1e6) * price.input +
    (hit / 1e6) * price.cacheRead +
    ((usage.completionTokens ?? 0) / 1e6) * price.output
  );
}

function usd(value) {
  if (value === undefined) return "n/a";
  return `$${value < 0.01 ? value.toFixed(6) : value.toFixed(4)}`;
}

function pct(hit, total) {
  if (typeof hit !== "number" || typeof total !== "number" || total <= 0) return "n/a";
  return `${((hit / total) * 100).toFixed(1)}%`;
}

/** A 0..1 ratio rendered as a percentage. */
function ratioPct(ratio) {
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return "n/a";
  return `${(ratio * 100).toFixed(1)}%`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function probeModel(opts, key, model) {
  const system = { role: "system", content: "You are a terse assistant. Answer only what is asked." };
  const nonce = opts.nonce ? `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}` : undefined;
  const prefixA = buildPrefix(SEED_A, opts.lines, nonce);
  const prefixB = buildPrefix(SEED_B, opts.lines, nonce);
  const turn = (prefix, question) => [{ role: "system", content: system.content }, { role: "user", content: `${prefix}\n\nQuestion: ${question}` }];
  const price = loadPrice(model);
  const rows = [];

  const call = async (phase, messages, note) => {
    const usage = await callModel({ base: opts.base, key, model, messages });
    const row = { phase, note, ...usage, cost: costOf(price, usage) };
    rows.push(row);
    if (!opts.quiet) {
      console.log(
        `  ${phase.padEnd(9)} prompt=${formatTokens(usage.promptTokens).padStart(8)}` +
          ` hit=${formatTokens(usage.hit).padStart(8)} miss=${formatTokens(usage.miss).padStart(7)}` +
          ` hit%=${pct(usage.hit, usage.promptTokens).padStart(6)}` +
          ` out=${formatTokens(usage.completionTokens).padStart(4)}` +
          ` think=${usage.thinking ? "yes" : "no "}` +
          ` ${usd(row.cost).padStart(10)} ${(usage.elapsedMs / 1000).toFixed(1)}s`,
      );
    }
    return usage;
  };

  const cold = await call("cold", turn(prefixA, QUESTION_1), "first contact with prefix A");
  await sleep(opts.settle);
  await call("repeat", turn(prefixA, QUESTION_1), "byte-identical resend; hits the persisted end-of-input unit");
  await sleep(opts.settle);
  const answer = cold.content.length > 0 ? cold.content : "(no content)";
  await call(
    "append",
    [
      { role: "system", content: system.content },
      { role: "user", content: `${prefixA}\n\nQuestion: ${QUESTION_1}` },
      { role: "assistant", content: answer },
      { role: "user", content: `Question: ${QUESTION_2}` },
    ],
    "normal multi-turn append",
  );
  await sleep(opts.settle);
  await call("branch", turn(prefixA, QUESTION_3), "divergent tail, but prefix A is already a persisted unit");
  await sleep(opts.settle);
  await call("fresh1", turn(prefixB, QUESTION_1), "a second prefix, never sent before");
  await sleep(opts.settle);
  await call("fresh2", turn(prefixB, QUESTION_3), "docs Example 2 exactly: A+B then A+C");

  return { model, price, rows, prefixes: { a: shortHash(prefixA), b: shortHash(prefixB) } };
}

function verdict(result) {
  const by = Object.fromEntries(result.rows.map((row) => [row.phase, row]));
  const ratio = (phase) => {
    const row = by[phase];
    if (!row || typeof row.hit !== "number" || !row.promptTokens) return undefined;
    return row.hit / row.promptTokens;
  };
  return {
    cold: ratio("cold"),
    repeat: ratio("repeat"),
    append: ratio("append"),
    branch: ratio("branch"),
    fresh2: ratio("fresh2"),
  };
}

/**
 * What the experiment established (see README, "Cache probe"): both models hit in
 * 128-token blocks, the tail beyond the last persisted block is always fresh, and a
 * warm ratio therefore approaches 100% as the prompt grows. So the reading below
 * reports the residue and the block alignment rather than pass/fail against the
 * docs' prose examples.
 */
function reading(result) {
  const by = Object.fromEntries(result.rows.map((row) => [row.phase, row]));
  const lines = [];
  const cold = by.cold;
  if (cold) {
    if ((cold.hit ?? 0) > 0) {
      lines.push(
        `cold      ${pct(cold.hit, cold.promptTokens)} — prefix A was still on DeepSeek's disk cache from an earlier run` +
          ` (persistence across processes; --nonce gives a real baseline)`,
      );
    } else {
      lines.push("cold      0.0% — first contact with the prefix misses");
    }
  }
  const warm = by.repeat;
  if (warm) {
    const residue = (warm.promptTokens ?? 0) - (warm.hit ?? 0);
    lines.push(
      `repeat    ${pct(warm.hit, warm.promptTokens)} — ${hitBlocks(warm)}; ${residue} tail tokens always re-sent`,
    );
  }
  const appended = by.append;
  if (appended) lines.push(`append    ${pct(appended.hit, appended.promptTokens)} — the appended turn hits the whole prior prefix`);
  const branched = by.branch;
  if (branched) lines.push(`branch    ${pct(branched.hit, branched.promptTokens)} — a diverging tail still hits the shared blocks`);
  const fresh2 = by.fresh2;
  if (fresh2) {
    lines.push(
      `fresh2    ${pct(fresh2.hit, fresh2.promptTokens)} — docs Example 2 predicts a miss here, but every complete` +
        ` 128-token block the first request persisted still hits; the documented miss needs a prefix with no persisted block`,
    );
  }
  const aligned = result.rows.filter((row) => (row.hit ?? 0) > 0).map((row) => row.hit % 128 === 0);
  if (aligned.length > 0) {
    lines.push(
      aligned.every(Boolean)
        ? "blocks    every hit is a whole number of 128-token blocks → 128-token cache granularity"
        : `blocks    not 128-aligned (hits: ${result.rows.filter((r) => (r.hit ?? 0) > 0).map((r) => r.hit).join(", ")}) — quantization may differ`,
    );
  }
  return lines;
}

function hitBlocks(row) {
  if (typeof row.hit !== "number") return "no hit tokens reported";
  return `${row.hit} tokens (${(row.hit / 128).toFixed(row.hit % 128 === 0 ? 0 : 2)} x 128)`;
}

function buildTable(results) {
  const header = ["model", "cold", "repeat", "append", "branch", "fresh2", "cost"];
  const lines = [`${header[0].padEnd(20)}${header.slice(1, 6).map((h) => h.padStart(9)).join("")}${header[6].padStart(12)}`];
  for (const result of results) {
    const v = verdict(result);
    const total = result.rows.reduce((sum, row) => sum + (row.cost ?? 0), 0);
    lines.push(
      `${result.model.padEnd(20)}${[v.cold, v.repeat, v.append, v.branch, v.fresh2].map((r) => ratioPct(r).padStart(9)).join("")}${usd(total).padStart(12)}`,
    );
  }
  return lines.join("\n");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0].replace(/^\/\*\*?/, ""));
    return;
  }
  const key = loadKey();
  console.log(
    `cache-probe  base=${opts.base}  prefix=${opts.lines} lines/model  settle=${opts.settle}ms  ` +
      `cold=${opts.nonce ? "guaranteed (nonce)" : "reused unless --nonce"}`,
  );
  console.log(`credential: loaded (${key.length} chars, ${key.slice(0, 3)}…)\n`);

  const results = [];
  for (const model of opts.models) {
    console.log(`${model}${loadPrice(model) ? "" : "  (no price in models.json)"}`);
    try {
      results.push(await probeModel(opts, key, model));
    } catch (error) {
      console.log(`  FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
    console.log("");
  }
  if (results.length === 0) {
    console.error("no model completed — check the credential and model id");
    process.exitCode = 1;
    return;
  }

  console.log("=== cache-hit ratio per phase (hit / prompt tokens) ===");
  console.log(buildTable(results));
  for (const result of results) {
    console.log(`  prefix sha256 (a/b): ${result.prefixes?.a} / ${result.prefixes?.b}  [${result.model}]`);
  }

  console.log("\n=== reading the result ===");
  for (const result of results) {
    const ratio = result.price && result.price.cacheRead > 0
      ? `, cache_read ${usd(result.price.cacheRead)}/M vs input ${usd(result.price.input)}/M = ${(result.price.input / result.price.cacheRead).toFixed(0)}x`
      : "";
    console.log(`${result.model}${ratio}`);
    for (const line of reading(result)) console.log(`  ${line}`);
    const cold = result.rows.find((row) => row.phase === "cold");
    const warm = result.rows.find((row) => row.phase === "repeat");
    if (cold && warm && cold.cost !== undefined && warm.cost !== undefined && warm.cost > 0) {
      console.log(`  saving    same request: ${usd(cold.cost)} cold → ${usd(warm.cost)} warm = ${(cold.cost / warm.cost).toFixed(1)}x cheaper`);
    }
  }

  const flash = results.find((r) => r.model.includes("flash"));
  const pro = results.find((r) => r.model.includes("pro"));
  if (flash && pro) {
    const a = verdict(flash);
    const b = verdict(pro);
    const same = (x, y) =>
      x === undefined || y === undefined
        ? "unknown"
        : Math.abs(x - y) <= 0.05
          ? "identical"
          : `differs (${(x * 100).toFixed(0)}% vs ${(y * 100).toFixed(0)}%)`;
    console.log("\n=== flash vs pro ===");
    for (const phase of ["repeat", "append", "branch", "fresh2"]) {
      console.log(`  ${phase.padEnd(8)} ${same(a[phase], b[phase])}`);
    }
    const hitRatio = flash.rows[1]?.hit && pro.rows[1]?.hit;
    if (hitRatio) {
      console.log(
        `  warm cost: flash ${usd(costOf(flash.price, flash.rows[1]))}/req vs pro ${usd(costOf(pro.price, pro.rows[1]))}/req` +
          ` (pro input is ${(pro.price.input / flash.price.input).toFixed(2)}x flash)`,
      );
    }
  }
}

main().catch((error) => {
  console.error(`cache-probe failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
