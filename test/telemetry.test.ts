import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { Hooks } from "@opencode-ai/plugin";
import { resolveOptions } from "../src/plugin.js";
import { warmHitRate } from "../src/render.js";
import { add, isZero, MILESTONES, reachedMilestone, readUsage, subtract } from "../src/telemetry.js";
import { createEventHandler } from "../src/telemetry.js";
import { assistantMessage, tempContext } from "../src/testkit.js";

type EventHook = NonNullable<Hooks["event"]>;
type EventInput = Parameters<EventHook>[0];

const SESSION = "ses_tel";

function statsOf(ctx: ReturnType<typeof tempContext>) {
  ctx.store.flushAll();
  return JSON.parse(readFileSync(join(ctx.dir, "sessions", `${SESSION}.json`), "utf8"));
}

test("readUsage accepts assistant accounting and rejects everything else", () => {
  const usage = readUsage(assistantMessage({ id: "a1", sessionID: SESSION, input: 10, cacheRead: 90, cost: 0.01 }));
  assert.ok(usage);
  assert.equal(usage?.cacheRead, 90);
  assert.equal(usage?.input, 10);
  assert.equal(usage?.completed, true);
  assert.equal(readUsage({ role: "user", id: "u1", sessionID: SESSION }), undefined);
  assert.equal(readUsage({ role: "assistant", id: "a1", sessionID: SESSION }), undefined);
  assert.equal(readUsage(null), undefined);
});

test("cumulative updates are converted to deltas", () => {
  const previous = { input: 100, output: 10, reasoning: 0, cacheRead: 1000, cacheWrite: 0, cost: 0.001 };
  const next = { input: 300, output: 40, reasoning: 5, cacheRead: 4000, cacheWrite: 0, cost: 0.004 };
  const delta = subtract(previous, next);
  assert.deepEqual(delta, { input: 200, output: 30, reasoning: 5, cacheRead: 3000, cacheWrite: 0, cost: 0.003 });
  assert.ok(isZero(subtract(next, next)));
  assert.deepEqual(add(delta, delta), {
    input: 400,
    output: 60,
    reasoning: 10,
    cacheRead: 6000,
    cacheWrite: 0,
    cost: 0.006,
  });
});

test("milestones announce the highest threshold crossed, once", () => {
  assert.equal(reachedMilestone(0.92, []), 0.9);
  assert.equal(reachedMilestone(0.92, [0.5, 0.8]), 0.9);
  assert.equal(reachedMilestone(0.92, [0.5, 0.8, 0.9]), undefined);
  assert.equal(reachedMilestone(0.4, []), undefined);
  assert.deepEqual(MILESTONES, [0.5, 0.8, 0.9, 0.95, 0.99]);
});

test("turn accounting: cold turn 1, cached turns 2+, duplicates ignored", async () => {
  const ctx = tempContext();
  try {
    const milestones: number[] = [];
    const hook = createEventHandler({
      registry: ctx.registry,
      logger: ctx.logger,
      options: resolveOptions({}),
      onMilestone: (_sessionID, _rate, milestone) => milestones.push(milestone),
    });
    const emit = async (info: unknown): Promise<void> => {
      await hook({ event: { type: "message.updated", properties: { info } } } as unknown as EventInput);
    };

    await emit(assistantMessage({ id: "a1", sessionID: SESSION, input: 1000, cacheRead: 0, cost: 0.0002 }));
    await emit(assistantMessage({ id: "a1", sessionID: SESSION, input: 1000, cacheRead: 0, cost: 0.0002 }));
    await emit(assistantMessage({ id: "a2", sessionID: SESSION, input: 1000, cacheRead: 9000, cost: 0.0004 }));
    await hook({ event: { type: "session.idle", properties: { sessionID: SESSION } } } as unknown as EventInput);

    const stats = statsOf(ctx);
    assert.equal(stats.turns, 2, "the repeated update for a1 must not count twice");
    assert.equal(stats.cacheRead, 9000);
    assert.equal(stats.missInput, 2000);
    assert.equal(stats.history.length, 2);
    assert.equal(stats.history[0].hitRate, 0, "turn 1 is cold");
    assert.ok(Math.abs(stats.history[1].hitRate - 0.9) < 1e-9, "turn 2 was 90% cache read")
    assert.ok(Math.abs(warmHitRate(stats.history) - 0.9) < 1e-9);
    assert.deepEqual(milestones, [0.9], "one announcement for the highest threshold crossed");
    assert.deepEqual(stats.milestones, [0.5, 0.8, 0.9]);
    assert.ok(stats.notes.some((note: string) => note.includes("cold start")));
  } finally {
    ctx.cleanup();
  }
});

test("multi-step turns inside one assistant message add up without double counting", async () => {
  const ctx = tempContext();
  try {
    const hook = createEventHandler({ registry: ctx.registry, logger: ctx.logger, options: resolveOptions({}) });
    const emit = async (info: unknown): Promise<void> => {
      await hook({ event: { type: "message.updated", properties: { info } } } as unknown as EventInput);
    };
    // One assistant message, three streamed steps: numbers are cumulative.
    await emit(assistantMessage({ id: "a1", sessionID: SESSION, input: 100, cacheRead: 0, completed: false }));
    await emit(assistantMessage({ id: "a1", sessionID: SESSION, input: 250, cacheRead: 1500, completed: false }));
    await emit(assistantMessage({ id: "a1", sessionID: SESSION, input: 400, cacheRead: 3000 }));
    const stats = statsOf(ctx);
    assert.equal(stats.turns, 1);
    assert.equal(stats.missInput, 400);
    assert.equal(stats.cacheRead, 3000);
    assert.equal(stats.history.length, 1);
  } finally {
    ctx.cleanup();
  }
});

test("non-DeepSeek usage is ignored completely", async () => {
  const ctx = tempContext();
  try {
    const hook = createEventHandler({ registry: ctx.registry, logger: ctx.logger, options: resolveOptions({}) });
    const foreign = assistantMessage({ id: "a1", sessionID: SESSION, input: 10, cacheRead: 90 });
    (foreign as Record<string, unknown>)["providerID"] = "openrouter";
    (foreign as Record<string, unknown>)["modelID"] = "z-ai/glm-5.3";
    await hook({ event: { type: "message.updated", properties: { info: foreign } } } as unknown as EventInput);
    assert.deepEqual(ctx.store.list(), []);
    assert.equal(ctx.registry.peek(SESSION)?.stats, undefined);
  } finally {
    ctx.cleanup();
  }
});

test("session.compacted marks the guard so the chain restart is not counted as a break", async () => {
  const ctx = tempContext();
  try {
    const hook = createEventHandler({ registry: ctx.registry, logger: ctx.logger, options: resolveOptions({}) });
    await hook({
      event: {
        type: "message.updated",
        properties: { info: assistantMessage({ id: "a1", sessionID: SESSION, input: 10, cacheRead: 90 }) },
      },
    } as unknown as EventInput);
    await hook({ event: { type: "session.compacted", properties: { sessionID: SESSION } } } as unknown as EventInput);
    const stats = statsOf(ctx);
    assert.equal(stats.compactions, 1);
    assert.equal(ctx.registry.peek(SESSION)?.pendingCompaction, true);
    assert.ok(stats.notes.some((note: string) => note.includes("compaction")));
  } finally {
    ctx.cleanup();
  }
});

test("an aborted assistant message is not counted as a turn", async () => {
  const ctx = tempContext();
  try {
    const hook = createEventHandler({ registry: ctx.registry, logger: ctx.logger, options: resolveOptions({}) });
    const emit = async (info: unknown): Promise<void> => {
      await hook({ event: { type: "message.updated", properties: { info } } } as unknown as EventInput);
    };
    await emit(assistantMessage({ id: "a1", sessionID: SESSION, input: 1000, cacheRead: 9000 }));
    // opencode records a stop/cancel as an assistant message with `error` set
    // and all-zero tokens (observed: error "Aborted", 0/0/0 tokens).
    await emit(assistantMessage({ id: "a2", sessionID: SESSION, input: 0, cacheRead: 0, error: { name: "AbortedError", data: { message: "Aborted" } } }));
    await emit(assistantMessage({ id: "a3", sessionID: SESSION, input: 1000, cacheRead: 18000 }));
    const stats = statsOf(ctx);
    assert.equal(stats.turns, 2, "the aborted placeholder must not count as a turn");
    assert.equal(stats.cacheRead, 27000);
    assert.equal(stats.missInput, 2000);
    assert.equal(stats.history.length, 2, "the aborted message added no history point");
    assert.ok(stats.history.every((point: { turn: number }) => point.turn !== 3));
  } finally {
    ctx.cleanup();
  }
});

test("aborted messages arrive in either shape: error string or object", () => {
  const stringShape = readUsage(assistantMessage({ id: "a1", sessionID: SESSION, input: 0, cacheRead: 0, error: "Aborted" }));
  const objectShape = readUsage(assistantMessage({ id: "a2", sessionID: SESSION, input: 0, cacheRead: 0, error: { name: "AbortedError" } }));
  const cleanShape = readUsage(assistantMessage({ id: "a3", sessionID: SESSION, input: 10, cacheRead: 90 }));
  assert.equal(stringShape?.errored, true);
  assert.equal(objectShape?.errored, true);
  assert.equal(cleanShape?.errored, false);
});

test("a zero-first-sighting placeholder counts as a turn only when usage arrives", async () => {
  const ctx = tempContext();
  try {
    const hook = createEventHandler({ registry: ctx.registry, logger: ctx.logger, options: resolveOptions({}) });
    const emit = async (info: unknown): Promise<void> => {
      await hook({ event: { type: "message.updated", properties: { info } } } as unknown as EventInput);
    };
    await emit(assistantMessage({ id: "a1", sessionID: SESSION, input: 1000, cacheRead: 9000 }));
    // Same shape as an aborted request but with no error field at all: a bare
    // zero placeholder must not count as a turn either.
    await emit(assistantMessage({ id: "a2", sessionID: SESSION, input: 0, cacheRead: 0 }));
    await emit(assistantMessage({ id: "a2", sessionID: SESSION, input: 1000, cacheRead: 18000 }));
    await emit(assistantMessage({ id: "a3", sessionID: SESSION, input: 1000, cacheRead: 27000 }));
    const stats = statsOf(ctx);
    assert.equal(stats.turns, 3, "a2 counted once, when its usage arrived");
    assert.equal(stats.history.length, 3);
    assert.deepEqual(
      stats.history.map((point: { turn: number }) => point.turn),
      [1, 2, 3],
      "turnIndex stays aligned with history points",
    );
  } finally {
    ctx.cleanup();
  }
});
