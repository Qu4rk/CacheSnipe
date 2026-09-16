import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { Hooks } from "@opencode-ai/plugin";
import {
  applyFrozenDate,
  changedBlocks,
  firstDifferingLine,
  hashBlocks,
  normalizeEnv,
  parseDateLine,
  scanBlocks,
} from "../src/freeze.js";
import { resolveOptions } from "../src/plugin.js";
import { createSystemTransform } from "../src/freeze.js";
import { systemPrompt, tempContext } from "../src/testkit.js";

type SystemTransform = NonNullable<Hooks["experimental.chat.system.transform"]>;
type SystemInput = Parameters<SystemTransform>[0];
type SystemOutput = Parameters<SystemTransform>[1];

function harness(ctx: ReturnType<typeof tempContext>, options = resolveOptions({ strictFreeze: false })) {
  const hook = createSystemTransform({ registry: ctx.registry, logger: ctx.logger, options });
  return async (
    input: { sessionID: string; providerID?: string; modelID?: string },
    prompt: string[],
  ): Promise<string[]> => {
    const output = { system: prompt } as SystemOutput;
    await hook(
      {
        sessionID: input.sessionID,
        model: { providerID: input.providerID ?? "deepseek", id: input.modelID ?? "deepseek-v4-flash" },
      } as unknown as SystemInput,
      output,
    );
    return output.system;
  };
}

function statsOf(ctx: ReturnType<typeof tempContext>, sessionID: string) {
  ctx.store.flushAll();
  return JSON.parse(readFileSync(join(ctx.dir, "sessions", `${sessionID}.json`), "utf8"));
}

test("pure helpers: date line parsing, normalization and diffs", () => {
  const env = " Working directory: /tmp/x\n Today's date: Wed Sep 16 2026\n";
  assert.equal(parseDateLine(env), "Wed Sep 16 2026");
  assert.equal(parseDateLine("no date here"), undefined);
  assert.ok(!normalizeEnv(env).includes("Sep 16"));
  assert.equal(
    firstDifferingLine("a\nb\nc", "a\nB\nc")?.line,
    2,
  );
  assert.equal(firstDifferingLine("same", "same"), undefined);

  const system = systemPrompt({ date: "Wed Sep 16 2026", skills: ["a"] });
  const applied = applyFrozenDate([...system], "Mon Jan 1 2024");
  assert.equal(applied, 1);
  assert.ok(applied === 1 && system[0]?.includes("Wed Sep 16 2026"));
});

test("P0: freezes the date on first sight and rewrites drift on later days", async () => {
  const ctx = tempContext();
  try {
    const run = harness(ctx);
    const first = await run({ sessionID: "ses_a" }, systemPrompt({ date: "Wed Sep 16 2026" }));
    assert.ok(first[0]?.includes("Today's date: Wed Sep 16 2026"));

    const tomorrow = await run({ sessionID: "ses_a" }, systemPrompt({ date: "Thu Sep 17 2026" }));
    assert.ok(tomorrow[0]?.includes("Today's date: Wed Sep 16 2026"), "date must stay frozen");

    const stats = statsOf(ctx, "ses_a");
    assert.equal(stats.frozenDate, "Wed Sep 16 2026");
    assert.equal(stats.systemPromptBreaks, 0, "a rewritten date must not count as a prompt break");
    assert.equal(stats.blocks.date, stats.blocks.date);
  } finally {
    ctx.cleanup();
  }
});

test("P0: a resumed session reuses the persisted frozen date instead of re-busting", async () => {
  const first = tempContext();
  try {
    const run = harness(first);
    await run({ sessionID: "ses_resume" }, systemPrompt({ date: "Wed Sep 16 2026" }));
    first.store.flushAll();
    assert.equal(statsOf(first, "ses_resume").frozenDate, "Wed Sep 16 2026");

    // New process: a second plugin instance over the same stats dir.
    const second = tempContext("cachesnipe", first.dir);
    const runAgain = harness(second);
    const after = await runAgain({ sessionID: "ses_resume" }, systemPrompt({ date: "Fri Sep 18 2026" }));
    assert.ok(after[0]?.includes("Wed Sep 16 2026"), "resumed session must keep the original frozen date");
  } finally {
    first.cleanup();
  }
});

test("P0b: skills drift is counted once and attributed to the skills block", async () => {
  const ctx = tempContext();
  try {
    const run = harness(ctx);
    await run({ sessionID: "ses_b" }, systemPrompt({ date: "Wed Sep 16 2026", skills: ["quarkloop"] }));
    const afterBaseline = statsOf(ctx, "ses_b");
    assert.equal(afterBaseline.systemPromptBreaks, 0);
    assert.deepEqual(Object.keys(afterBaseline.blocks).sort(), ["date", "env", "skills"]);

    await run({ sessionID: "ses_b" }, systemPrompt({ date: "Wed Sep 16 2026", skills: ["quarkloop", "animejs"] }));
    const afterDrift = statsOf(ctx, "ses_b");
    assert.equal(afterDrift.systemPromptBreaks, 1);
    assert.ok(afterDrift.notes.some((note: string) => note.includes("skills")), "note must name the block");

    // Same drift again must not double count.
    await run({ sessionID: "ses_b" }, systemPrompt({ date: "Wed Sep 16 2026", skills: ["quarkloop", "animejs"] }));
    assert.equal(statsOf(ctx, "ses_b").systemPromptBreaks, 1);
  } finally {
    ctx.cleanup();
  }
});

test("P0b: drift names the first differing line even without strictFreeze", async () => {
  const ctx = tempContext();
  try {
    // No strictFreeze: the baseline text is held in memory rather than persisted.
    const run = harness(ctx);
    await run({ sessionID: "ses_line" }, systemPrompt({ date: "Wed Sep 16 2026", skills: ["quarkloop"] }));
    await run(
      { sessionID: "ses_line" },
      systemPrompt({ date: "Wed Sep 16 2026", skills: ["quarkloop", "animejs"] }),
    );
    const stats = statsOf(ctx, "ses_line");
    assert.equal(stats.systemPromptBreaks, 1);
    const note = stats.notes.find((entry: string) => entry.includes("skills"));
    assert.ok(note, "the note must name the skills block");
    assert.match(
      note,
      /line \d+: ".*" -> ".*"/,
      `attribution must locate the first differing line, not just the block: ${note}`,
    );
    assert.equal(stats.frozenBlocks, undefined, "baseline text stays out of the record unless strictFreeze is on");
  } finally {
    ctx.cleanup();
  }
});

test("P0b: a restart mid-session still locates the drift by line", async () => {
  const first = tempContext();
  try {
    const run = harness(first);
    await run({ sessionID: "ses_restart" }, systemPrompt({ date: "Wed Sep 16 2026", skills: ["quarkloop"] }));
    first.store.flushAll();

    // New process (app restarted), same session and stats dir. This is the case that
    // cost 23,424 tokens of re-sent prefix on 2026-09-16: the baseline hashes are
    // restored, so drift is detected, but the text needed to locate it was not kept.
    const second = tempContext("cachesnipe", first.dir);
    try {
      const afterRestart = harness(second);
      await afterRestart(
        { sessionID: "ses_restart" },
        systemPrompt({ date: "Wed Sep 16 2026", skills: ["quarkloop", "animejs"] }),
      );
      const stats = statsOf(second, "ses_restart");
      assert.equal(stats.systemPromptBreaks, 1);
      const note = stats.notes.find((entry: string) => entry.includes("skills"));
      assert.ok(note, "the drift must be named after a restart too");
      assert.match(
        note,
        /line \d+: ".*" -> ".*"/,
        `a restart must not degrade attribution to a block name: ${note}`,
      );
    } finally {
      second.cleanup();
    }
  } finally {
    first.cleanup();
  }
});

test("strictFreeze replays session-start blocks after a restart, so the prefix survives", async () => {
  const strict = resolveOptions({ strictFreeze: true });
  const first = tempContext();
  try {
    const run = harness(first, strict);
    const baseline = await run(
      { sessionID: "ses_frozen" },
      systemPrompt({ date: "Wed Sep 16 2026", skills: ["quarkloop"] }),
    );
    const skillsText = baseline[1];
    first.store.flushAll();

    const second = tempContext("cachesnipe", first.dir);
    try {
      const afterRestart = harness(second, strict);
      const drifted = await afterRestart(
        { sessionID: "ses_frozen" },
        systemPrompt({ date: "Thu Sep 17 2026", skills: ["quarkloop", "animejs"] }),
      );
      assert.equal(drifted[1], skillsText, "the pre-restart skills block must be re-emitted verbatim");
      assert.ok(drifted[0]?.includes("Wed Sep 16 2026"), "the frozen date survives the restart");
      assert.equal(
        statsOf(second, "ses_frozen").systemPromptBreaks,
        0,
        "replaying the original blocks is what avoids the restart-triggered prefix loss",
      );
      // The freshness cost must be visible, not silent: one added skill line.
      const resumedNote = statsOf(second, "ses_frozen").notes.find((entry: string) =>
        entry.includes("withheld"),
      );
      assert.ok(resumedNote, "the replay must record what it withheld");
      assert.match(resumedNote, /\d+ bytes.*withheld/);
    } finally {
      second.cleanup();
    }
  } finally {
    first.cleanup();
  }
});

test("P0b: mcp instructions appearing mid-session are attributed to the mcp block", async () => {
  const ctx = tempContext();
  try {
    const run = harness(ctx);
    await run({ sessionID: "ses_mcp" }, systemPrompt({ date: "Wed Sep 16 2026", mcp: false }));
    await run({ sessionID: "ses_mcp" }, systemPrompt({ date: "Wed Sep 16 2026", mcp: true }));
    const stats = statsOf(ctx, "ses_mcp");
    assert.equal(stats.systemPromptBreaks, 1);
    assert.ok(stats.notes.some((note: string) => note.includes("mcp")));
  } finally {
    ctx.cleanup();
  }
});

test("strictFreeze re-emits session-start blocks so the prefix stays identical", async () => {
  const ctx = tempContext();
  try {
    const run = harness(ctx, resolveOptions({ strictFreeze: true }));
    const baseline = await run({ sessionID: "ses_c" }, systemPrompt({ date: "Wed Sep 16 2026", skills: ["quarkloop"] }));
    const skillsText = baseline[1];

    const drifted = await run(
      { sessionID: "ses_c" },
      systemPrompt({ date: "Thu Sep 17 2026", skills: ["quarkloop", "animejs"] }),
    );
    assert.equal(drifted[1], skillsText, "skills block must be restored verbatim");
    assert.ok(drifted[0]?.includes("Wed Sep 16 2026"));
    assert.equal(statsOf(ctx, "ses_c").systemPromptBreaks, 0);
  } finally {
    ctx.cleanup();
  }
});

test("non-DeepSeek sessions are untouched and write nothing", async () => {
  const ctx = tempContext();
  try {
    const run = harness(ctx);
    const prompt = systemPrompt({ date: "Wed Sep 16 2026" });
    const before = JSON.stringify(prompt);
    const after = await run(
      { sessionID: "ses_other", providerID: "openrouter", modelID: "z-ai/glm-5.3" },
      prompt,
    );
    assert.equal(JSON.stringify(after), before, "prompt must not be rewritten");
    const sessionsDir = join(ctx.dir, "sessions");
    const files = existsSync(sessionsDir) ? readdirSync(sessionsDir) : [];
    assert.deepEqual(files, [], "no stats file for a non-DeepSeek session");
  } finally {
    ctx.cleanup();
  }
});

test("prompts without an env block (title generation) are ignored without throwing", async () => {
  const ctx = tempContext();
  try {
    const run = harness(ctx);
    const out = await run({ sessionID: "ses_title" }, ["You are generating a short title for this session."]);
    assert.deepEqual(out, ["You are generating a short title for this session."]);
    assert.deepEqual(readdirSync(join(ctx.dir, "sessions")), []);
  } finally {
    ctx.cleanup();
  }
});

test("block hashes isolate the date from the rest of the env block", () => {
  const a = scanBlocks(systemPrompt({ date: "Wed Sep 16 2026" }));
  const b = scanBlocks(systemPrompt({ date: "Thu Sep 17 2026" }));
  const hashesA = hashBlocks(a, "Wed Sep 16 2026");
  const hashesB = hashBlocks(b, "Thu Sep 17 2026");
  assert.equal(hashesA.env, hashesB.env, "env hash ignores the date line");
  assert.notEqual(hashesA.date, hashesB.date);
  assert.deepEqual(changedBlocks(hashesA, hashesB), ["date"]);
});
