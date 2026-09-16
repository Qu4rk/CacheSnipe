import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { estimateSavings, estimateUncached, fallbackPriceTable, loadPriceTable, parsePriceTable } from "../src/prices.js";
import { hitRateOf, prefixLost, renderGraph, renderSummary, warmHitRate } from "../src/render.js";
import { mergeSessions, StatsStore, storePaths } from "../src/store.js";
import { createLogger } from "../src/log.js";
import { MAX_HISTORY_POINTS } from "../src/types.js";
import { tempContext } from "../src/testkit.js";
import type { SessionStats } from "../src/types.js";

function sampleStats(overrides: Partial<SessionStats> = {}): SessionStats {
  const now = Date.now();
  return {
    sessionID: "ses_sample",
    directory: "/tmp/project",
    providerID: "deepseek",
    modelID: "deepseek-v4-flash",
    frozenDate: "Wed Sep 16 2026",
    createdAt: now,
    updatedAt: now,
    turns: 3,
    requests: 3,
    cacheRead: 27_000,
    cacheWrite: 0,
    missInput: 3_000,
    output: 500,
    reasoning: 100,
    cost: 0.01,
    prefixBreaks: 0,
    systemPromptBreaks: 0,
    rewinds: 1,
    compactions: 0,
    promptHash: "abcdef0123456789",
    blocks: { date: "1111111111111111", env: "2222222222222222", skills: "3333333333333333" },
    history: [
      { turn: 1, at: now, cacheRead: 0, missInput: 1_000, output: 200, cost: 0.002, hitRate: 0 },
      { turn: 2, at: now, cacheRead: 9_000, missInput: 1_000, output: 150, cost: 0.004, hitRate: 0.9 },
      { turn: 3, at: now, cacheRead: 18_000, missInput: 1_000, output: 150, cost: 0.004, hitRate: 0.947 },
    ],
    milestones: [0.5, 0.8, 0.9],
    notes: ["turn 1 cold start (nothing to cache yet)"],
    chain: ["a", "b", "c"],
    ...overrides,
  };
}

test("write/read roundtrip and derived reports", () => {
  const ctx = tempContext();
  try {
    const stats = sampleStats();
    ctx.store.put(stats);
    ctx.store.markDirty(stats.sessionID);
    ctx.store.flush(stats.sessionID);
    ctx.store.writeDerived(stats);

    const paths = storePaths(ctx.dir);
    assert.ok(existsSync(paths.summary));
    assert.ok(existsSync(paths.graph));
    assert.ok(existsSync(paths.aggregate));
    assert.ok(existsSync(join(paths.sessions, "ses_sample.json")));

    const reopened = new StatsStore({ dir: ctx.dir, logger: ctx.logger, retentionDays: 30 }).read("ses_sample");
    assert.equal(reopened?.cacheRead, 27_000);
    assert.equal(reopened?.frozenDate, "Wed Sep 16 2026");

    const summary = readFileSync(paths.summary, "utf8");
    assert.ok(summary.includes("ses_sample"));
    assert.ok(summary.includes("est. saved"));
    assert.ok(summary.includes("prefix breaks"));
    assert.ok(summary.includes("trend (last 3 turns)"));
    assert.ok(!summary.includes("WARNING: prune is not disabled"), "no warning when prune is unset");

    const graph = readFileSync(paths.graph, "utf8");
    assert.ok(graph.includes("turn     hit%"));
    assert.ok(graph.includes("legend"));
  } finally {
    ctx.cleanup();
  }
});

test("the rendered report names the session that was flushed, not a placeholder", () => {
  const ctx = tempContext();
  try {
    const paths = storePaths(ctx.dir);
    // Nothing observed yet: the placeholder is correct here.
    ctx.store.writeDerived();
    assert.ok(readFileSync(paths.summary, "utf8").includes("nothing observed yet"));

    const stats = sampleStats();
    ctx.store.put(stats);
    ctx.store.flush(stats.sessionID);

    // /cache-stats reads this file, so it has to carry the session's own numbers.
    const summary = readFileSync(paths.summary, "utf8");
    assert.ok(summary.includes("this session  ses_sample  deepseek/deepseek-v4-flash"), summary.slice(0, 200));
    assert.ok(!summary.includes("nothing observed yet"));
    assert.ok(summary.includes("prefix lost (turns 2+)"));
    assert.ok(summary.includes("trend (last 3 turns)"));
    assert.ok(readFileSync(paths.graph, "utf8").includes("turn     hit%"), "the graph follows the same session");
  } finally {
    ctx.cleanup();
  }
});

test("prefix lost is 0 while reads grow and counts a re-sent prefix", () => {
  const growing = [
    { turn: 1, at: 0, cacheRead: 0, missInput: 1_000, output: 0, cost: 0, hitRate: 0 },
    { turn: 2, at: 0, cacheRead: 1_000, missInput: 500, output: 0, cost: 0, hitRate: 0.66 },
    { turn: 3, at: 0, cacheRead: 4_000, missInput: 200, output: 0, cost: 0, hitRate: 0.95 },
  ];
  assert.equal(prefixLost(growing), 0, "reads only grew, so no cached prefix was re-sent");
  assert.equal(prefixLost(sampleStats().history), 0);
  assert.equal(prefixLost([]), 0);

  // A cold reset: turn 3 reads less than turn 2 had cached.
  const reset = [...growing, { turn: 4, at: 0, cacheRead: 300, missInput: 6_000, output: 0, cost: 0, hitRate: 0.05 }];
  assert.equal(prefixLost(reset), 3_700);
});

test("the summary warns when compaction.prune is not disabled", () => {
  const summary = renderSummary({
    current: sampleStats(),
    sessions: [sampleStats()],
    priceTable: loadPriceTable(),
    config: { prune: true, compactionModel: "deepseek/deepseek-v4-flash", compactionTemperature: 0, smallModel: "deepseek/deepseek-v4-flash" },
  });
  assert.ok(summary.includes("WARNING: prune is not disabled"));
  assert.ok(summary.includes("deepseek/deepseek-v4-flash @ temp 0"));
});

test("hit-rate math ignores the cold first turn", () => {
  const stats = sampleStats();
  assert.ok(Math.abs(hitRateOf(stats) - 0.9) < 1e-9);
  assert.ok(Math.abs(warmHitRate(stats.history) - 0.9310344827586207) < 1e-9);
  assert.equal(warmHitRate([]), 0);
});

test("concurrent writers converge: merging keeps the larger counters", () => {
  const left = sampleStats({ cacheRead: 100, turns: 2, prefixBreaks: 0 });
  const right = sampleStats({ cacheRead: 500, turns: 4, prefixBreaks: 1 });
  const merged = mergeSessions(left, right);
  assert.equal(merged.cacheRead, 500);
  assert.equal(merged.turns, 4);
  assert.equal(merged.prefixBreaks, 1);
});

test("retention cleanup removes only stale records", () => {
  const ctx = tempContext();
  try {
    // A genuinely old record is written straight to disk: `flush` refreshes
    // updatedAt, which is exactly what keeps live sessions off the chopping block.
    const old = sampleStats({ sessionID: "ses_old", updatedAt: Date.now() - 45 * 24 * 60 * 60 * 1000 });
    const recent = sampleStats({ sessionID: "ses_new" });
    writeFileSync(join(ctx.dir, "sessions", "ses_old.json"), JSON.stringify(old));
    ctx.store.put(recent);
    ctx.store.markDirty(recent.sessionID, 0);
    ctx.store.flush(recent.sessionID);
    assert.ok(existsSync(join(ctx.dir, "sessions", "ses_old.json")));
    const removed = ctx.store.cleanup();
    assert.equal(removed, 1);
    assert.ok(!existsSync(join(ctx.dir, "sessions", "ses_old.json")));
    assert.ok(existsSync(join(ctx.dir, "sessions", "ses_new.json")));
  } finally {
    ctx.cleanup();
  }
});

test("prices come from models.json and savings use the cache-read delta", () => {
  const table = parsePriceTable({
    deepseek: {
      models: {
        "deepseek-v4-flash": { cost: { input: 0.15, output: 0.6, cache_read: 0.003 } },
        "deepseek-v4-pro": { cost: { input: 0.435, output: 0.87, cache_read: 0.003625 } },
      },
    },
  });
  const flash = table.get("deepseek", "deepseek-v4-flash");
  assert.ok(flash);
  assert.equal(flash?.origin, "models.json");
  assert.ok(Math.abs(estimateSavings(flash, 1_000_000) - 0.147) < 1e-9);
  assert.ok(
    Math.abs(
      estimateUncached(flash, { input: 0, output: 0, reasoning: 0, cacheRead: 1_000_000, cacheWrite: 0, cost: 0 }) - 0.15,
    ) < 1e-9,
  );
  assert.ok(Math.abs((table.get("deepseek", "deepseek-v4-pro")?.input ?? 0) - 0.435) < 1e-9);
});

test("the fallback table is used when models.json is unreadable", () => {
  const table = loadPriceTable("/nonexistent/models.json");
  assert.equal(table.origin, "fallback");
  assert.equal(fallbackPriceTable().get("deepseek", "deepseek-v4-flash")?.cacheRead, 0.003);
  assert.equal(fallbackPriceTable().get("deepseek", "deepseek-v4-pro")?.input, 0.435);
});

test("a corrupt session record is skipped instead of breaking the report", () => {
  const dir = mkdtempSync(join(tmpdir(), "cachesnipe-corrupt-"));
  try {
    const store = new StatsStore({ dir, logger: createLogger({ dir }), retentionDays: 30 });
    const paths = storePaths(dir);
    writeFileSync(join(paths.sessions, "ses_broken.json"), "{not json");
    store.put(sampleStats({ sessionID: "ses_ok" }));
    store.flush("ses_ok");
    const listed = store.list();
    assert.deepEqual(listed.map((session) => session.sessionID), ["ses_ok"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("graph rendering handles an empty history", () => {
  const graph = renderGraph({ current: sampleStats({ history: [], turns: 0 }), sessions: [], priceTable: loadPriceTable() });
  assert.ok(graph.includes("no turns recorded yet"));
  assert.ok(graph.includes("none yet"));
});

test("reading heals a legacy record: trailing zero point popped, turns re-aligned", () => {
  const ctx = tempContext();
  try {
    const paths = storePaths(ctx.dir);
    const legacy = sampleStats({
      turns: 4,
      history: [
        ...sampleStats().history,
        { turn: 4, at: Date.now(), cacheRead: 0, missInput: 0, output: 0, cost: 0, hitRate: 0 },
      ],
    });
    writeFileSync(join(paths.sessions, "ses_sample.json"), `${JSON.stringify(legacy, null, 2)}\n`);

    const healed = ctx.store.read("ses_sample");
    assert.equal(healed?.turns, 3, "phantom turn removed");
    assert.equal(healed?.history.length, 3, "trailing zero-usage point dropped");
    assert.ok(healed?.notes.some((note: string) => note.includes("healed")), "healing is visible in the notes");
    // The totals the provider reported are untouched.
    assert.equal(healed?.cacheRead, 27_000);

    // Re-reading must not add a second heal note.
    const again = ctx.store.read("ses_sample");
    assert.equal(again?.notes.filter((note: string) => note.includes("healed")).length, 1);
  } finally {
    ctx.cleanup();
  }
});

test("healing leaves a capped, consistent record alone", () => {
  const ctx = tempContext();
  try {
    const paths = storePaths(ctx.dir);
    const now = Date.now();
    const capped = sampleStats({
      turns: MAX_HISTORY_POINTS,
      history: Array.from({ length: MAX_HISTORY_POINTS }, (_, index) => ({
        turn: index + 1,
        at: now,
        cacheRead: 1_000,
        missInput: 100,
        output: 10,
        cost: 0.0001,
        hitRate: 0.9,
      })),
    });
    writeFileSync(join(paths.sessions, "ses_sample.json"), `${JSON.stringify(capped, null, 2)}\n`);

    const loaded = ctx.store.read("ses_sample");
    assert.equal(loaded?.turns, MAX_HISTORY_POINTS, "capped history is consistent: nothing to heal");
    assert.ok(!loaded?.notes.some((note: string) => note.includes("healed")));
  } finally {
    ctx.cleanup();
  }
});
