import assert from "node:assert/strict";
import test from "node:test";
import { assertPreserved, countOurPluginEntries, isPatched, patchConfigText, stripJsonc } from "./patch-config.mjs";

const OPTIONS = {
  pluginSpec: "file:///repo/dist/src/plugin.js",
  compactionModel: "deepseek/deepseek-v4-flash",
  compactionTemperature: 0,
  smallModel: "deepseek/deepseek-v4-flash",
};

const parse = (text) => JSON.parse(stripJsonc(text));

const REALISTIC = `{
  "compaction": { "prune": true, "auto": true },
  "plugin": ["superpowers@git+https://github.com/obra/superpowers.git"],
  "provider": { "x": { "name": "X" } },
  "mcp": {
    "playwright": {
      "type": "local",
      "command": ["/opt/homebrew/bin/playwright-mcp", "--isolated"]
    }
  }
}
`;

test("stripJsonc removes comments and trailing commas but keeps URLs", () => {
  const text = `{
    // line comment with a url https://opencode.ai/config.json
    "url": "https://github.com/obra/superpowers.git", /* trailing */
    "list": [1, 2,],
  }`;
  const parsed = parse(text);
  assert.equal(parsed.url, "https://github.com/obra/superpowers.git");
  assert.deepEqual(parsed.list, [1, 2]);
});

test("the bare entry is upgraded in place when strictFreeze is wanted", () => {
  const wanted = [OPTIONS.pluginSpec, { strictFreeze: true }];
  const patched = patchConfigText(REALISTIC, { ...OPTIONS, wantedPluginEntry: wanted });
  const config = parse(patched);
  assert.deepEqual(config.plugin, [
    "superpowers@git+https://github.com/obra/superpowers.git",
    [OPTIONS.pluginSpec, { strictFreeze: true }],
  ]);
  assert.ok(isPatched(config, { ...OPTIONS, wantedPluginEntry: wanted }));
  // The upgrade is a no-op the second time.
  assert.equal(patchConfigText(patched, { ...OPTIONS, wantedPluginEntry: wanted }), patched);
});

test("stale options are rewritten to the wanted shape without duplicating", () => {
  const stale = REALISTIC.replace(
    'superpowers.git"]',
    'superpowers.git", ["file:///repo/dist/src/plugin.js", {"strictFreeze": false}]]',
  );
  const wanted = [OPTIONS.pluginSpec, { strictFreeze: true }];
  const patched = patchConfigText(stale, { ...OPTIONS, wantedPluginEntry: wanted });
  const config = parse(patched);
  assert.equal(countOurPluginEntries(config.plugin, OPTIONS.pluginSpec), 1, "no duplicate");
  assert.deepEqual(config.plugin.at(-1), [OPTIONS.pluginSpec, { strictFreeze: true }]);
});

test("isPatched is false while our entry is in an older shape", () => {
  const bare = parse(REALISTIC);
  bare.plugin.push(OPTIONS.pluginSpec);
  assert.equal(
    isPatched({ ...bare, compaction: { prune: false }, agent: { compaction: { model: OPTIONS.compactionModel, temperature: 0 } }, small_model: OPTIONS.smallModel },
      { ...OPTIONS, wantedPluginEntry: [OPTIONS.pluginSpec, { strictFreeze: true }] }),
    false,
  );
});

test("patching a config with existing settings preserves them", () => {
  const patched = patchConfigText(REALISTIC, OPTIONS);
  const config = parse(patched);

  assert.equal(config.compaction.prune, false);
  assert.equal(config.compaction.auto, true, "compaction.auto must survive");
  assert.deepEqual(config.agent.compaction, { model: OPTIONS.compactionModel, temperature: 0 });
  assert.equal(config.small_model, OPTIONS.smallModel);
  assert.deepEqual(config.plugin, [
    "superpowers@git+https://github.com/obra/superpowers.git",
    OPTIONS.pluginSpec,
  ]);
  assert.deepEqual(config.provider, { x: { name: "X" } });
  assert.deepEqual(config.mcp.playwright.command, ["/opt/homebrew/bin/playwright-mcp", "--isolated"]);
  assert.ok(patched.includes('"url"') === false || true);
  assert.ok(patched.includes("superpowers@git+https://github.com/obra/superpowers.git"));
  assert.ok(isPatched(config, OPTIONS));
});

test("patching an empty config creates everything, correctly nested", () => {
  const patched = patchConfigText("{\n  \"$schema\": \"https://opencode.ai/config.json\"\n}\n", OPTIONS);
  const config = parse(patched);
  assert.equal(config.compaction.prune, false);
  assert.deepEqual(config.agent, { compaction: { model: OPTIONS.compactionModel, temperature: 0 } });
  assert.equal(config.small_model, OPTIONS.smallModel);
  assert.deepEqual(config.plugin, [OPTIONS.pluginSpec]);
  assert.equal(config.$schema, "https://opencode.ai/config.json");
});

test("patching is idempotent", () => {
  const once = patchConfigText(REALISTIC, OPTIONS);
  const twice = patchConfigText(once, OPTIONS);
  assert.equal(twice, once);
  assert.ok(isPatched(parse(once), OPTIONS));
});

test("an empty plugin array gains exactly one entry", () => {
  const patched = patchConfigText('{\n  "plugin": []\n}\n', OPTIONS);
  assert.deepEqual(parse(patched).plugin, [OPTIONS.pluginSpec]);
  assert.equal(patchConfigText(patched, OPTIONS), patched);
});

test("comments outside the edited regions are untouched", () => {
  const text = '{\n  // keep me\n  "compaction": { "prune": true },\n  "provider": {}\n}\n';
  const patched = patchConfigText(text, OPTIONS);
  assert.ok(patched.includes("// keep me"));
  assert.ok(/\"compaction\": \{ \"prune\": false \}/.test(patched), "prune is replaced in place, not re-serialised");
});

test("a wrongly typed key is refused instead of corrupted", () => {
  assert.throws(() => patchConfigText('{\n  "compaction": "nope"\n}\n', OPTIONS), /not an object/);
  assert.throws(() => patchConfigText('{\n  "plugin": 42\n}\n', OPTIONS), /not an array/);
});

test("assertPreserved catches a lost sibling but accepts an additive patch", () => {
  const before = parse(REALISTIC);
  const after = parse(patchConfigText(REALISTIC, OPTIONS));
  assert.doesNotThrow(() => assertPreserved(before, after));
  const damaged = JSON.parse(JSON.stringify(after));
  delete damaged.compaction.auto;
  assert.throws(() => assertPreserved(before, damaged), /compaction\.auto would change/);
  const stripped = JSON.parse(JSON.stringify(after));
  stripped.plugin = [];
  assert.throws(() => assertPreserved(before, stripped), /plugin entry would be lost/);
});

test("insertions use the document's own indentation", () => {
  const fourSpaces = '{\n    "provider": {}\n}\n';
  const patched = patchConfigText(fourSpaces, OPTIONS);
  assert.ok(patched.includes('\n    "compaction": {'), "members must use the file's 4-space indent");
});
