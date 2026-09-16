import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { Hooks } from "@opencode-ai/plugin";
import { chainOf, classify, createMessagesTransform, isPrefixOf, messageHash, projectParts } from "../src/guard.js";
import { systemPrompt, tempContext, textMessage, toolMessage } from "../src/testkit.js";

type MessagesTransform = NonNullable<Hooks["experimental.chat.messages.transform"]>;
type MessagesInput = Parameters<MessagesTransform>[0];
type MessagesOutput = Parameters<MessagesTransform>[1];

const SESSION = "ses_guard";

function statsOf(ctx: ReturnType<typeof tempContext>, sessionID: string) {
  ctx.store.flushAll();
  return JSON.parse(readFileSync(join(ctx.dir, "sessions", `${sessionID}.json`), "utf8"));
}

function harness(ctx: ReturnType<typeof tempContext>) {
  const hook = createMessagesTransform({ registry: ctx.registry, logger: ctx.logger });
  // The real plugin activates from the system transform / assistant messages;
  // the guard counts only for sessions already known to be DeepSeek.
  const session = ctx.registry.observe(SESSION);
  ctx.registry.activate(session, { providerID: "deepseek", modelID: "deepseek-v4-flash" });
  return async (messages: unknown[]): Promise<void> => {
    const output = { messages } as unknown as MessagesOutput;
    await hook({} as MessagesInput, output);
  };
}

test("projectParts ignores streaming and bookkeeping parts", () => {
  const parts = [
    { type: "step-start" },
    { type: "text", text: "hello" },
    { type: "step-finish", cost: 0.1, tokens: { input: 5 } },
    { type: "snapshot", snapshot: "abc" },
  ];
  assert.deepEqual(projectParts(parts), [{ type: "text", text: "hello" }]);
});

test("tool output changes are visible; tool metadata churn is not", () => {
  const base = { type: "tool", tool: "read", callID: "c1", state: { status: "completed", output: "A" } };
  const rewritten = { ...base, state: { status: "completed", output: "[Old tool result content cleared]" } };
  const noisy = { ...base, time: { start: 1, end: 99 } };
  const left = messageHash({ info: { id: "m1", role: "assistant" }, parts: [base] });
  const right = messageHash({ info: { id: "m1", role: "assistant" }, parts: [rewritten] });
  const noisyHash = messageHash({ info: { id: "m1", role: "assistant" }, parts: [noisy] });
  assert.notEqual(left.hash, right.hash, "prune rewrites must change the prefix hash");
  assert.equal(left.hash, noisyHash.hash, "timing fields must not affect the hash");
});

test("chains are stable for identical content and differ for edited content", () => {
  const a = [textMessage({ sessionID: SESSION, role: "user", text: "one", id: "m1" })];
  const b = [textMessage({ sessionID: SESSION, role: "user", text: "one", id: "m1" })];
  const c = [textMessage({ sessionID: SESSION, role: "user", text: "two", id: "m1" })];
  assert.equal(chainOf(a)[0]?.hash, chainOf(b)[0]?.hash);
  assert.notEqual(chainOf(a)[0]?.hash, chainOf(c)[0]?.hash);
});

test("classify distinguishes extension, rewind, compaction and divergence", () => {
  const chain = (hashes: string[]) => hashes.map((hash, index) => ({ hash, id: `m${index}`, role: "user" }));
  assert.equal(classify([], chain(["a"]), { compaction: false }).kind, "first");
  assert.equal(classify(["a"], chain(["a", "b"]), { compaction: false }).kind, "extension");
  assert.equal(classify(["a", "b", "c"], chain(["a", "b"]), { compaction: false }).kind, "rewind");
  assert.equal(classify(["a", "b", "c", "d"], chain(["x"]), { compaction: true }).kind, "compaction");

  const divergence = classify(["a", "b", "c"], chain(["a", "z", "c"]), { compaction: false });
  assert.equal(divergence.kind, "divergence");
  assert.equal(divergence.index, 1);
  assert.equal(divergence.at?.id, "m1");

  const trimmed = classify(["a", "b", "c"], chain(["a", "b", "z"]), { compaction: false });
  assert.equal(trimmed.kind, "divergence", "an edited tail message is a break");

  assert.ok(isPrefixOf(["a", "b"], ["a", "b", "c"]));
  assert.ok(!isPrefixOf(["a", "z"], ["a", "b", "c"]));
});

test("P2: growing history counts as requests, an undo is a rewind, a rewrite is a break", async () => {
  const ctx = tempContext();
  try {
    const run = harness(ctx);
    const turn1 = [textMessage({ sessionID: SESSION, role: "user", text: "turn 1" })];
    await run(turn1);
    const turn2 = [...turn1, textMessage({ sessionID: SESSION, role: "assistant", text: "answer 1" }), textMessage({ sessionID: SESSION, role: "user", text: "turn 2" })];
    await run(turn2);
    const turn3 = [...turn2, textMessage({ sessionID: SESSION, role: "assistant", text: "answer 2" }), textMessage({ sessionID: SESSION, role: "user", text: "turn 3" })];
    await run(turn3);

    let stats = statsOf(ctx, SESSION);
    assert.equal(stats.requests, 2, "the first request has no previous chain to compare");
    assert.equal(stats.prefixBreaks, 0);
    assert.equal(stats.rewinds, 0);

    // /undo + retry: history is truncated, then re-grows. Cache-safe.
    await run(turn3.slice(0, 3));
    stats = statsOf(ctx, SESSION);
    assert.equal(stats.rewinds, 1);
    assert.equal(stats.prefixBreaks, 0, "a truncation is not a prefix break");

    // compaction: opencode says so, so it is not counted as a break either.
    const session = ctx.registry.peek(SESSION);
    assert.ok(session);
    session.pendingCompaction = true;
    await run([textMessage({ sessionID: SESSION, role: "user", text: "summary of everything so far" })]);
    stats = statsOf(ctx, SESSION);
    assert.equal(stats.prefixBreaks, 0);
    assert.equal(session.pendingCompaction, false, "the flag must be consumed");

    // prune-style rewrite of an old message: the real break.
    const pruned = [
      toolMessage({ sessionID: SESSION, callID: "c9", tool: "read", output: "[Old tool result content cleared]" }),
      textMessage({ sessionID: SESSION, role: "assistant", text: "answer 1" }),
      textMessage({ sessionID: SESSION, role: "user", text: "turn 2" }),
    ];
    await run(pruned);
    stats = statsOf(ctx, SESSION);
    assert.equal(stats.prefixBreaks, 1, "exactly one break, once");
    assert.ok(stats.notes.some((note: string) => note.startsWith("prefix break #1")));
  } finally {
    ctx.cleanup();
  }
});

test("P2: sessions that are not DeepSeek are never counted", async () => {
  const ctx = tempContext();
  try {
    const hook = createMessagesTransform({ registry: ctx.registry, logger: ctx.logger });
    const first = [textMessage({ sessionID: "ses_other", role: "user", text: "one" })];
    const second = [...first, textMessage({ sessionID: "ses_other", role: "assistant", text: "two" }), textMessage({ sessionID: "ses_other", role: "user", text: "three" })];
    await hook({} as MessagesInput, { messages: second } as unknown as MessagesOutput);
    await hook({} as MessagesInput, { messages: first } as unknown as MessagesOutput);
    assert.equal(ctx.registry.peek("ses_other")?.stats, undefined);
    assert.deepEqual(ctx.store.list(), []);
  } finally {
    ctx.cleanup();
  }
});

test("system prompts are irrelevant to the guard's chain", () => {
  // Documents why P0/P0b and P2 must both exist: the message chain cannot see
  // the system prompt at all.
  const prompts = systemPrompt({ date: "Wed Sep 16 2026" });
  assert.ok(prompts.length > 0);
  assert.equal(chainOf([textMessage({ sessionID: SESSION, role: "user", text: "hi" })]).length, 1);
});
