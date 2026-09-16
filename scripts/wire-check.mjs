#!/usr/bin/env node
/**
 * wire-check — drives the compiled plugin exactly the way opencode will, without opencode.
 *
 * The live-install risk is not the config diff (that is inspectable) but the hook
 * wiring: whether the artifact registers the hooks opencode calls, and whether the
 * freeze / guard / telemetry do their job when opencode hands them real payloads.
 * This script imports `dist/src/plugin.js` — the same file the config points at —
 * builds the stub `PluginInput` opencode would supply, calls `server()`, drives
 * every hook with the payload shapes found in opencode 1.18.30/31
 * (`{ model, sessionID }` + `{ system }`, `{ messages }`, `{ sessionID }` +
 * `{ prompt, context }`, `{ event }`), and then reads the stats files it wrote.
 *
 * Order matters and cost a debugging round: the plugin persists session state on
 * flush, not on every hook, so everything is *acted* first, `dispose()` flushes,
 * and only then are file-backed assertions evaluated. Asserting mid-run reads
 * `undefined` and looks like a bug in the plugin.
 *
 * It writes only into a throwaway temp stats dir, so it never touches real sessions.
 *
 * Usage:
 *   node scripts/wire-check.mjs
 *   node scripts/wire-check.mjs --keep   # leave the temp stats dir in place to inspect
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = new URL("../dist/src/plugin.js", import.meta.url);
const session = "ses_wirecheck";
const otherSession = "ses_wirecheck_other";
const skillsSession = "ses_wirecheck_skills";

let passed = 0;
let failed = 0;
const deferred = [];

function section(title) {
  console.log(`\n== ${title}`);
}
function check(name, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
/** Assertion against persisted state; evaluated after the plugin has flushed. */
function checkAfter(name, evaluate) {
  deferred.push({ name, evaluate });
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}
function readLog(dir) {
  try {
    return readFileSync(join(dir, "cachesnipe.log"), "utf8");
  } catch {
    return "";
  }
}
const message = (id, role, text, sessionID = session) => ({
  info: { id, role, sessionID },
  parts: [{ type: "text", text }],
});
const promptWithDate = (date) =>
  [
    "You are opencode, an agentic coding assistant.",
    "<env>",
    "  Working directory: /tmp/wire-check",
    `  Today's date: ${date}`,
    "</env>",
  ].join("\n");
/**
 * Real opencode sends each block as its own system entry. Concatenating them into
 * one string makes the env hash cover the skills text too, which produces a
 * spurious `env` break — a harness bug this script made once already.
 */
const withSkills = (names) =>
  `<available_skills>\n${names.map((name) => `  <skill name="${name}"/>`).join("\n")}\n</available_skills>`;

const deepseekModel = { providerID: "deepseek", api: { id: "deepseek-v4-flash" } };
const otherModel = { providerID: "openrouter", api: { id: "anthropic/claude-sonnet-4.5" } };

async function main() {
  const keep = process.argv.includes("--keep");
  const statsDir = mkdtempSync(join(tmpdir(), "cachesnipe-wirecheck-"));
  const client = {
    app: { log: async () => ({}) },
    session: { get: async () => ({ data: { title: "wire check" } }), update: async () => ({}) },
  };

  console.log(`wire-check  entry=${ENTRY.pathname}`);
  console.log(`stats dir=${statsDir} (throwaway)`);

  section("load and hook surface");
  const mod = await import(ENTRY.href);
  check("plugin module imports", typeof mod.default === "object", `id=${mod.PLUGIN_ID} v=${mod.PLUGIN_VERSION}`);
  check("server() is exported as a function", typeof mod.server === "function");

  const hooks = await mod.server(
    { client, directory: "/tmp/wire-check", worktree: "/tmp/wire-check" },
    { statsDir },
  );
  const names = Object.keys(hooks ?? {});
  for (const required of [
    "config",
    "experimental.chat.system.transform",
    "experimental.chat.messages.transform",
    "experimental.session.compacting",
    "event",
  ]) {
    check(`registers hook ${required}`, names.includes(required));
  }

  const transform = hooks["experimental.chat.system.transform"];
  const messagesTransform = hooks["experimental.chat.messages.transform"];
  const compacting = hooks["experimental.session.compacting"];
  const emit = hooks.event;

  // ---------------------------------------------------------------- act: config
  section("config snapshot and prune warning");
  await hooks.config({ compaction: { prune: true }, agent: { compaction: {} } });
  await hooks.config({
    compaction: { prune: false },
    agent: { compaction: { model: "deepseek/deepseek-v4-flash", temperature: 0 } },
    small_model: "deepseek/deepseek-v4-flash",
  });
  checkAfter("warns when compaction.prune is not disabled — the mid-session prefix buster", () => ({
    ok: readLog(statsDir).includes("compaction.prune is not disabled"),
    detail: "grep 'prune is not disabled' in cachesnipe.log",
  }));
  checkAfter("captures the compaction model, temperature and prune flag", () => {
    const snapshot = readJson(join(statsDir, "config.json"));
    return {
      ok: snapshot?.prune === false && snapshot?.compactionTemperature === 0,
      detail: JSON.stringify({ prune: snapshot?.prune, temperature: snapshot?.compactionTemperature, model: snapshot?.compactionModel }),
    };
  });

  // ------------------------------------------------- act: non-DeepSeek control
  section("non-DeepSeek session is untouched (criterion 1)");
  const otherSystem = [promptWithDate("Mon Sep 14 2026")];
  await transform({ model: otherModel, sessionID: otherSession }, { system: otherSystem });
  await messagesTransform({}, { messages: [message("m1", "user", "hello", otherSession)] });
  check("an OpenRouter/Claude prompt is not rewritten", otherSystem[0].includes("Mon Sep 14 2026"));
  checkAfter("no stats file is created for it", () => ({
    ok: !existsSync(join(statsDir, "sessions", `${otherSession}.json`)),
    detail: `${otherSession}.json absent`,
  }));

  // -------------------------------------------------------------- act: P0 freeze
  section("date freeze (criterion 6)");
  const first = [promptWithDate("Mon Sep 14 2026")];
  await transform({ model: deepseekModel, sessionID: session }, { system: first });
  check("first turn keeps the observed date", first[0].includes("Today's date: Mon Sep 14 2026"));
  const second = [promptWithDate("Tue Sep 15 2026")];
  await transform({ model: deepseekModel, sessionID: session }, { system: second });
  check(
    "a drifted date is rewritten back to the frozen one",
    second[0].includes("Today's date: Mon Sep 14 2026") && !second[0].includes("Sep 15"),
    "the midnight-rollover fix",
  );
  checkAfter("the frozen date is persisted for a future resume", () => {
    const stats = readJson(join(statsDir, "sessions", `${session}.json`));
    return { ok: stats?.frozenDate === "Mon Sep 14 2026", detail: `frozenDate=${stats?.frozenDate}` };
  });

  // ---------------------------------------------------------- act: P0b block drift
  section("block drift is attributed (P0b)");
  // A block present from the session's first prompt can be diffed line by line.
  await transform({ model: deepseekModel, sessionID: skillsSession }, { system: [promptWithDate("Mon Sep 14 2026"), withSkills(["commit"])] });
  await transform({ model: deepseekModel, sessionID: skillsSession }, { system: [promptWithDate("Mon Sep 14 2026"), withSkills(["commit", "deploy"])] });
  checkAfter("a changed skills block is named, with the first differing line", () => {
    const stats = readJson(join(statsDir, "sessions", `${skillsSession}.json`));
    const note = (stats?.notes ?? []).find((entry) => String(entry).includes("prompt break")) ?? "";
    return {
      ok: stats?.systemPromptBreaks === 1 && /skills .*line \d+: ".*" -> ".*"/.test(note),
      detail: note || "no prompt-break note recorded",
    };
  });
  // A block that appears mid-session has no baseline text to compare against.
  await transform({ model: deepseekModel, sessionID: session }, { system: [promptWithDate("Mon Sep 14 2026"), withSkills(["commit"])] });
  checkAfter("a block appearing mid-session is named and flagged as un-locatable", () => {
    const stats = readJson(join(statsDir, "sessions", `${session}.json`));
    const note = (stats?.notes ?? []).find((entry) => String(entry).includes("prompt break")) ?? "";
    return { ok: stats?.systemPromptBreaks === 1 && note.includes("no baseline text"), detail: note };
  });

  // ------------------------------------------------------------ act: P2 guard
  section("prefix guard (criteria 2 and 4)");
  const chain1 = [message("m1", "user", "read the file"), message("m2", "assistant", "done")];
  const chain2 = [...chain1, message("m3", "user", "now edit it")];
  const rewritten = [chain1[0], message("m2", "assistant", "done, but rewritten"), chain2[2]];
  await messagesTransform({}, { messages: chain1 }); // first
  await messagesTransform({}, { messages: chain2 }); // extension
  await messagesTransform({}, { messages: chain1 }); // /undo-style rewind
  await messagesTransform({}, { messages: rewritten }); // real rewrite
  // `requests` counts *guarded* requests: the first one only establishes the chain,
  // so three of the four calls above are counted.
  checkAfter("counts guarded requests (the chain-establishing first one excluded)", () => {
    const stats = readJson(join(statsDir, "sessions", `${session}.json`));
    return { ok: stats?.requests === 3, detail: `requests=${stats?.requests}` };
  });
  checkAfter("an extension is not a break", () => {
    const stats = readJson(join(statsDir, "sessions", `${session}.json`));
    return { ok: stats?.prefixBreaks === 1, detail: `prefixBreaks=${stats?.prefixBreaks} (only the rewrite should count)` };
  });
  checkAfter("/undo-style truncation counts as a rewind, not a break", () => {
    const stats = readJson(join(statsDir, "sessions", `${session}.json`));
    return { ok: stats?.rewinds === 1 && stats?.prefixBreaks === 1, detail: `rewinds=${stats?.rewinds} prefixBreaks=${stats?.prefixBreaks}` };
  });
  checkAfter("the break names the divergent message index", () => {
    const stats = readJson(join(statsDir, "sessions", `${session}.json`));
    const note = (stats?.notes ?? []).find((entry) => String(entry).startsWith("prefix break")) ?? "";
    return { ok: note.includes("prefix break #1 at message 1"), detail: note || "no break note recorded" };
  });

  // ------------------------------------------------------ act: P3 compaction
  section("compaction (criterion 5)");
  const compactOutput = { prompt: "ORIGINAL", context: [] };
  await compacting({ sessionID: session }, compactOutput);
  check("does not replace the prompt in the default mode", compactOutput.prompt === "ORIGINAL");
  checkAfter("logs the configured model, temperature and prune state", () => {
    const line = readLog(statsDir).split("\n").find((entry) => entry.includes("compaction starting")) ?? "";
    const ok =
      line.includes('"model":"deepseek/deepseek-v4-flash"') &&
      line.includes('"temperature":0') &&
      line.includes('"prune":false');
    return { ok, detail: line.trim().slice(-160) || "no compaction line" };
  });

  // ------------------------------------------------------- act: P1 telemetry
  section("telemetry (criteria 2 and 7)");
  const turns = [
    { id: "a1", input: 5000, read: 0, output: 300, reasoning: 100, cost: 0.002 },
    { id: "a2", input: 250, read: 4800, output: 320, reasoning: 90, cost: 0.0004 },
    { id: "a3", input: 200, read: 9600, output: 280, reasoning: 80, cost: 0.0003 },
  ];
  for (const turn of turns) {
    await emit({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: turn.id,
            role: "assistant",
            sessionID: session,
            providerID: "deepseek",
            modelID: "deepseek-v4-flash",
            cost: turn.cost,
            time: { completed: Date.now() },
            tokens: { input: turn.input, output: turn.output, reasoning: turn.reasoning, cache: { read: turn.read, write: 0 } },
          },
        },
      },
    });
  }
  // A non-DeepSeek assistant message must be ignored entirely.
  await emit({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: "other1",
          role: "assistant",
          sessionID: otherSession,
          providerID: "openrouter",
          modelID: "anthropic/claude-sonnet-4.5",
          tokens: { input: 999, output: 99, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    },
  });
  // A stop/cancel arrives as an errored assistant message with zero usage, and a
  // bare zero placeholder arrives with no error at all. Neither is a request;
  // neither may count as a turn or push a history point (2026-09-16 incident:
  // an aborted message rendered as a 111,872-token cold re-send).
  await emit({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: "a4",
          role: "assistant",
          sessionID: session,
          providerID: "deepseek",
          modelID: "deepseek-v4-flash",
          error: { name: "AbortedError", data: { message: "Aborted" } },
          time: { created: Date.now(), completed: Date.now() },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    },
  });
  await emit({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: "a5",
          role: "assistant",
          sessionID: session,
          providerID: "deepseek",
          modelID: "deepseek-v4-flash",
          time: { created: Date.now(), completed: Date.now() },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    },
  });
  await emit({ event: { type: "session.idle", properties: { sessionID: session } } });

  // ------------------------------------------- act: hook diagnostics (timing)
  // Three cases, each in its own plugin instance with an 80ms window. This exists
  // because the live install logged "experimental hooks never fired" twenty seconds
  // after load — true at that instant, false a minute later, and misleading.
  section("hook diagnostics only fire once a request has gone out");
  const previousWindow = process.env.CACHESNIPE_DIAGNOSTIC_MS ?? process.env.CACHE_HITTER_DIAGNOSTIC_MS;
  process.env.CACHESNIPE_DIAGNOSTIC_MS = "80";
  const diagDirs = [];
  const spawn = async (name) => {
    const dir = mkdtempSync(join(tmpdir(), `cachesnipe-${name}-`));
    diagDirs.push(dir);
    return { dir, instance: await mod.server({ client, directory: "/tmp/wire-check", worktree: "/tmp/wire-check" }, { statsDir: dir }) };
  };
  const assistantEvent = (sessionID, id) => ({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id,
          role: "assistant",
          sessionID,
          providerID: "deepseek",
          modelID: "deepseek-v4-flash",
          tokens: { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    },
  });

  // (1) events flow, no request yet → stay quiet
  const quiet = await spawn("diag-quiet");
  await quiet.instance.event({ event: { type: "session.idle", properties: {} } });
  await new Promise((resolve) => setTimeout(resolve, 200));

  // (2) a request goes out and both hooks fire → reported as active
  const active = await spawn("diag-active");
  await active.instance["experimental.chat.system.transform"](
    { model: deepseekModel, sessionID: "ses_diag" },
    { system: [promptWithDate("Mon Sep 14 2026")] },
  );
  await active.instance["experimental.chat.messages.transform"]({}, { messages: [message("m1", "user", "hi", "ses_diag")] });
  await active.instance.event(assistantEvent("ses_diag", "d1"));
  await new Promise((resolve) => setTimeout(resolve, 250));
  await active.instance.dispose?.();
  await quiet.instance.dispose?.();

  // (3) a request goes out and the hooks never fire → the warning is earned
  const silent = await spawn("diag-silent");
  await silent.instance.event(assistantEvent("ses_diag_silent", "d2"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  await silent.instance.dispose?.();

  // (4) app start re-emits historical assistant messages; none of them is a request
  const historical = await spawn("diag-history");
  await historical.instance.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: "replayed1",
          role: "assistant",
          sessionID: "ses_diag_history",
          providerID: "deepseek",
          modelID: "deepseek-v4-flash",
          time: { created: Date.now() - 600_000, completed: Date.now() - 599_000 },
          tokens: { input: 5, output: 1, reasoning: 0, cache: { read: 4, write: 0 } },
        },
      },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  await historical.instance.dispose?.();

  if (previousWindow === undefined) {
    delete process.env.CACHESNIPE_DIAGNOSTIC_MS;
    delete process.env.CACHE_HITTER_DIAGNOSTIC_MS;
  } else {
    process.env.CACHESNIPE_DIAGNOSTIC_MS = previousWindow;
  }

  check(
    "no warning while no request has been made yet",
    !readLog(quiet.dir).includes("never fired"),
    "events flowing is not evidence of anything",
  );
  check(
    "reports the hooks as active once both have fired",
    readLog(active.dir).includes("all hooks active") && !readLog(active.dir).includes("never fired"),
  );
  check(
    "warns only when a request went out and the hooks stayed silent",
    readLog(silent.dir).includes("a request went out but experimental hooks never fired"),
  );
  check(
    "a replayed historical message on app start is not treated as a request",
    !readLog(historical.dir).includes("never fired"),
    "this false alarm fired 20s after the 2026-09-16 restart",
  );

  // --------------------------------------- act: strictFreeze across a restart
  // Two plugin instances over one stats dir, the second created only after the
  // first has flushed — the exact shape of an app restart. With strictFreeze on,
  // the drifted blocks are re-emitted and no break is counted.
  section("strictFreeze replays session-start blocks after a restart");
  const sfDir = mkdtempSync(join(tmpdir(), "cachesnipe-sf-"));
  const sfOptions = { statsDir: sfDir, strictFreeze: true };
  const sfFirst = await mod.server({ client, directory: "/tmp/wire-check", worktree: "/tmp/wire-check" }, sfOptions);
  const sfBaseline = [promptWithDate("Mon Sep 14 2026"), withSkills(["commit"])];
  await sfFirst["experimental.chat.system.transform"](
    { model: deepseekModel, sessionID: "ses_sf" },
    { system: sfBaseline },
  );
  await sfFirst.dispose?.();

  const sfSecond = await mod.server({ client, directory: "/tmp/wire-check", worktree: "/tmp/wire-check" }, sfOptions);
  const sfDrifted = [promptWithDate("Tue Sep 15 2026"), withSkills(["commit", "animejs"])];
  await sfSecond["experimental.chat.system.transform"](
    { model: deepseekModel, sessionID: "ses_sf" },
    { system: sfDrifted },
  );
  await sfSecond.dispose?.();

  check(
    "the pre-restart blocks are replayed verbatim",
    sfDrifted[1] === sfBaseline[1] && sfDrifted[0].includes("Mon Sep 14 2026"),
    "date and skills restored, so the provider sees the same prefix",
  );
  const sfStats = readJson(join(sfDir, "sessions", "ses_sf.json"));
  check(
    "no prompt break is counted when replay succeeds",
    sfStats?.systemPromptBreaks === 0,
    `systemPromptBreaks=${sfStats?.systemPromptBreaks}`,
  );
  check(
    "the replay is visible in the log",
    readLog(sfDir).includes("system prompt drift re-frozen (strictFreeze)"),
    "grep this line after a real restart to confirm the mechanism engaged",
  );

  // ------------------------------------------------------------- flush and assert
  await hooks.dispose?.();
  await new Promise((resolve) => setTimeout(resolve, 120));
  section("persisted state (after flush)");
  for (const { name, evaluate } of deferred) {
    try {
      const { ok, detail } = evaluate();
      check(name, ok, detail);
    } catch (error) {
      check(name, false, error instanceof Error ? error.message : String(error));
    }
  }

  const finalStats = readJson(join(statsDir, "sessions", `${session}.json`));
  check("counts one turn per assistant message", finalStats?.turns === 3, `turns=${finalStats?.turns}`);
  check(
    "aborted and zero-placeholder messages add no turn and no history point",
    finalStats?.turns === 3 && finalStats?.history?.length === 3,
    `turns=${finalStats?.turns} history=${finalStats?.history?.length}`,
  );
  check("session.idle adds no phantom turn", finalStats?.turns === 3, "regression guard for the double-finalize bug");
  check(
    "accumulates cache reads and miss input separately",
    finalStats?.cacheRead === 14400 && finalStats?.missInput === 5450,
    `cacheRead=${finalStats?.cacheRead} missInput=${finalStats?.missInput}`,
  );
  const warm = finalStats?.history?.length ? finalStats.history.slice(1) : [];
  const warmRate = warm.length
    ? warm.reduce((sum, point) => sum + (point.hitRate ?? 0), 0) / warm.length
    : 0;
  check("warm turns (2+) hit at or above the 90% bar", warmRate >= 0.9, `warm hit rate ${(warmRate * 100).toFixed(1)}% over ${warm.length} turns`);

  section("what a real session will look like");
  for (const file of ["sessions", "summary.txt", "graph.txt", "aggregate.json", "config.json", "cachesnipe.log"]) {
    check(`writes ${file}`, existsSync(join(statsDir, file)));
  }
  const summary = join(statsDir, "summary.txt");
  if (existsSync(summary)) {
    console.log("\n---- summary.txt (/cache-stats renders this) ----");
    console.log(readFileSync(summary, "utf8").trimEnd());
    console.log("---- end summary ----");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
  console.log(`temp stats dir: ${statsDir}${keep ? " (kept)" : " (safe to delete)"}`);
}

main().catch((error) => {
  console.error(`wire-check failed: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
