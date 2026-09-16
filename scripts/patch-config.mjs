#!/usr/bin/env node
/**
 * Config patcher.
 *
 * `~/.config/opencode/opencode.json(c)` is a hand-maintained, 24 KB document
 * full of providers, MCP servers and comments. Re-serialising it through
 * JSON.parse would destroy all of that, so this script edits the *text*
 * surgically:
 *
 *   - keys are located with a depth-aware scanner that understands strings and
 *     JSONC comments (never a regex over the whole file, so a `//` inside a URL
 *     never confuses it);
 *   - only the tokens that need changing are inserted or replaced, so sibling
 *     keys inside `compaction`/`agent` and every comment survive verbatim;
 *   - insertions are formatted with the document's own indentation, so the diff
 *     looks hand-written;
 *   - the result is re-parsed (comments stripped) and asserted before writing:
 *     expected settings present, no pre-existing top-level key lost, provider
 *     count unchanged, exactly one plugin entry added, nothing else touched.
 *
 * Idempotent: a second run reports "already up to date" and writes nothing.
 *
 * Usage:
 *   node scripts/patch-config.mjs --file ~/.config/opencode/opencode.json \
 *     --file ~/.config/opencode/opencode.jsonc \
 *     --plugin-spec file:///abs/dist/src/plugin.js [--dry-run] [--apply]
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** True when this file is the entry point; the module is importable for tests. */
export const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

const args = isMain ? process.argv.slice(2) : [];

function flag(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function multiFlag(name) {
  const out = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) out.push(args[index + 1]);
  }
  return out;
}

const files = multiFlag("--file");
const apply = args.includes("--apply");
const dryRun = args.includes("--dry-run") || !apply;
const pluginSpec = flag("--plugin-spec");
const strictFreeze = args.includes("--strict-freeze");
const compactionModel = flag("--compaction-model") ?? "deepseek/deepseek-v4-flash";
const compactionTemperature = Number(flag("--compaction-temperature") ?? "0");
const smallModel = flag("--small-model") ?? "deepseek/deepseek-v4-flash";

/** The plugin entry this configuration should carry, options included. */
function wantedPluginEntry() {
  const pluginOptions = strictFreeze ? { strictFreeze: true } : undefined;
  return pluginOptions === undefined ? pluginSpec : [pluginSpec, pluginOptions];
}

/** Counts entries that belong to this plugin, whatever shape they were written in. */
export function countOurPluginEntries(list, spec) {
  return (list ?? []).filter((entry) =>
    typeof entry === "string" ? entry === spec : Array.isArray(entry) && entry[0] === spec,
  ).length;
}

if (isMain && (files.length === 0 || !pluginSpec)) {
  console.error(
    "usage: patch-config.mjs --file <config> [--file <config>] --plugin-spec <file:///.../plugin.js> [--apply|--dry-run]",
  );
  process.exit(2);
}

// ---------------------------------------------------------------- scanning --

/** Removes comments and trailing commas so the text can be parsed for verification. */
export function stripJsonc(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  let inLine = false;
  let inBlock = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inLine) {
      if (char === "\n") {
        inLine = false;
        out += char;
      }
      continue;
    }
    if (inBlock) {
      if (char === "*" && next === "/") {
        inBlock = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLine = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlock = true;
      index += 1;
      continue;
    }
    out += char;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function skipTrivia(text, index) {
  let cursor = index;
  while (cursor < text.length) {
    const char = text[cursor];
    if (char === undefined) break;
    if (/\s/.test(char)) {
      cursor += 1;
      continue;
    }
    if (char === "/" && text[cursor + 1] === "/") {
      const newline = text.indexOf("\n", cursor);
      cursor = newline === -1 ? text.length : newline + 1;
      continue;
    }
    if (char === "/" && text[cursor + 1] === "*") {
      const end = text.indexOf("*/", cursor);
      cursor = end === -1 ? text.length : end + 2;
      continue;
    }
    break;
  }
  return cursor;
}

/** Range of the value starting at `index` (start inclusive, end exclusive). */
export function valueRange(text, index) {
  const start = skipTrivia(text, index);
  const first = text[start];
  if (first === undefined) return undefined;
  if (first === '"') {
    let cursor = start + 1;
    let escaped = false;
    while (cursor < text.length) {
      const char = text[cursor];
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') return { start, end: cursor + 1, kind: "string" };
      cursor += 1;
    }
    return undefined;
  }
  if (first === "{" || first === "[") {
    const open = first;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let cursor = start;
    let inString = false;
    let escaped = false;
    while (cursor < text.length) {
      const char = text[cursor];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
      } else if (char === '"') {
        inString = true;
      } else if (char === "/" && text[cursor + 1] === "/") {
        const newline = text.indexOf("\n", cursor);
        cursor = newline === -1 ? text.length : newline;
        continue;
      } else if (char === "/" && text[cursor + 1] === "*") {
        const end = text.indexOf("*/", cursor);
        cursor = end === -1 ? text.length : end + 2;
        continue;
      } else if (char === open) {
        depth += 1;
      } else if (char === close) {
        depth -= 1;
        if (depth === 0) return { start, end: cursor + 1, kind: open === "{" ? "object" : "array" };
      }
      cursor += 1;
    }
    return undefined;
  }
  let cursor = start;
  while (cursor < text.length && !/[,\]}[\s]/.test(text[cursor])) cursor += 1;
  return { start, end: cursor, kind: "primitive" };
}

/**
 * Finds `"key": <value>` inside [from, to). When `requiredDepth` is given, only
 * keys nested exactly that deep (relative to `from`) are considered — this is
 * what keeps a top-level lookup from matching a same-named nested key.
 */
export function findKey(text, key, from = 0, to = text.length, requiredDepth) {
  const needle = `"${key}"`;
  let cursor = skipTrivia(text, from);
  let depth = 0;
  while (cursor < to) {
    const char = text[cursor];
    if (char === '"') {
      const range = valueRange(text, cursor);
      if (!range) return undefined;
      if ((requiredDepth === undefined || depth === requiredDepth) && text.slice(range.start, range.end) === needle) {
        const colon = skipTrivia(text, range.end);
        if (text[colon] === ":") {
          const value = valueRange(text, colon + 1);
          if (value) return { keyStart: range.start, keyEnd: range.end, value };
        }
      }
      cursor = range.end;
      continue;
    }
    if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") depth -= 1;
    cursor += 1;
  }
  return undefined;
}

// ---------------------------------------------------------------- editing ---

export function detectIndentUnit(text) {
  const match = /^([ \t]+)"/m.exec(text);
  return match?.[1] ?? "  ";
}

/** Leading whitespace of the line that contains `index`. */
function lineIndentAt(text, index) {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart, index))?.[0] ?? "";
}

/** Serialises a value, indenting continuation lines so it sits inside the document. */
function formatValue(value, baseIndent) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  return JSON.stringify(value, null, 2)
    .split("\n")
    .map((line, index) => (index === 0 ? line : `${baseIndent}${line}`))
    .join("\n");
}

function rootObjectRange(text) {
  const first = text.indexOf("{");
  if (first === -1) throw new Error("no top-level object found");
  const range = valueRange(text, first);
  if (!range) throw new Error("unbalanced top-level object");
  return range;
}

function replaceRange(text, range, replacement) {
  return `${text.slice(0, range.start)}${replacement}${text.slice(range.end)}`;
}

/** Inserts `"key": value,` lines as the first members of `object`, using its indentation. */
export function insertNamedMembers(text, object, entries, indentUnit = "  ") {
  if (entries.length === 0) return text;
  const memberIndent = lineIndentAt(text, object.start) + indentUnit;
  const lines = entries.map(([key, value]) => `${memberIndent}"${key}": ${formatValue(value, memberIndent)},`);
  // The document's own newline+indent after `{` provides the separator that
  // follows our last line, so nothing is duplicated.
  const insertion = `\n${lines.join("\n")}`;
  return `${text.slice(0, object.start + 1)}${insertion}${text.slice(object.start + 1)}`;
}

/** Appends an item to an array value, matching the array's formatting. */
export function appendArrayItem(text, array, item, indentUnit = "  ") {
  const body = text.slice(array.start + 1, array.end - 1);
  const serialized = JSON.stringify(item);
  const multiline = body.includes("\n");
  if (body.trim() === "") {
    if (!multiline) return `${text.slice(0, array.start + 1)}${serialized}${text.slice(array.start + 1)}`;
    const itemIndent = lineIndentAt(text, array.start) + indentUnit;
    const closeIndent = lineIndentAt(text, array.start);
    return `${text.slice(0, array.start + 1)}\n${itemIndent}${serialized}\n${closeIndent}${text.slice(array.start + 1)}`;
  }
  // Insert after the last non-whitespace character of the body, so the trailing
  // newline+indent before `]` is preserved and the comma lands correctly.
  let lastContent = array.start;
  for (let index = array.end - 2; index > array.start; index -= 1) {
    if (!/\s/.test(text[index])) {
      lastContent = index;
      break;
    }
  }
  const separator = multiline ? `\n${lineIndentAt(text, array.start) + indentUnit}` : " ";
  return `${text.slice(0, lastContent + 1)},${separator}${serialized}${text.slice(lastContent + 1)}`;
}

function member(text, key) {
  const root = rootObjectRange(text);
  return findKey(text, key, root.start, root.end, 1);
}

function buildValue(path, value) {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  return { [head]: buildValue(rest, value) };
}

function setMember(text, object, key, value) {
  const existing = findKey(text, key, object.start, object.end, 1);
  if (existing) return replaceRange(text, existing.value, JSON.stringify(value));
  return insertNamedMembers(text, object, [[key, value]]);
}

/** Sets `path` to `value` (scalar, array or whole object), creating parents. */
export function setValueAtPath(text, path, value) {
  const rootKey = path[0];
  const found = member(text, rootKey);
  if (path.length === 1) {
    if (found) return replaceRange(text, found.value, JSON.stringify(value));
    return insertNamedMembers(text, rootObjectRange(text), [[rootKey, value]]);
  }
  if (!found) {
    return insertNamedMembers(text, rootObjectRange(text), [[rootKey, buildValue(path.slice(1), value)]]);
  }
  if (found.value.kind !== "object") throw new Error(`"${rootKey}" exists but is not an object; refusing to patch`);
  let current = text;
  let object = found.value;
  for (let index = 1; index < path.length; index += 1) {
    const key = path[index];
    const child = findKey(current, key, object.start, object.end, 1);
    if (!child) {
      return insertNamedMembers(current, object, [[key, buildValue(path.slice(index + 1), value)]]);
    }
    if (index === path.length - 1) return replaceRange(current, child.value, JSON.stringify(value));
    if (child.value.kind !== "object") throw new Error(`"${key}" exists but is not an object; refusing to patch`);
    object = child.value;
  }
  return current;
}

/** Merges `entries` into the object at `path`, preserving members it does not mention. */
export function mergeObjectAtPath(text, path, entries) {
  let current = text;
  let object = member(current, path[0])?.value;
  if (!object) {
    return insertNamedMembers(current, rootObjectRange(current), [[path[0], buildValue(path.slice(1), entries)]]);
  }
  if (object.kind !== "object") throw new Error(`"${path[0]}" exists but is not an object; refusing to patch`);
  for (let index = 1; index < path.length; index += 1) {
    const key = path[index];
    let child = findKey(current, key, object.start, object.end, 1);
    if (!child) {
      current = insertNamedMembers(current, object, [[key, {}]]);
      object = valueRange(current, object.start) ?? object;
      child = findKey(current, key, object.start, object.end, 1);
      if (!child) throw new Error(`could not create "${key}"`);
    }
    if (child.value.kind !== "object") throw new Error(`"${key}" exists but is not an object; refusing to patch`);
    object = child.value;
  }

  // Replacements first (they never move the object's opening brace), then a
  // single formatted insertion for whatever is still missing.
  const missing = [];
  for (const [entryKey, entryValue] of Object.entries(entries)) {
    const existing = findKey(current, entryKey, object.start, object.end, 1);
    if (existing) {
      current = replaceRange(current, existing.value, JSON.stringify(entryValue));
      object = valueRange(current, object.start) ?? object;
    } else {
      missing.push([entryKey, entryValue]);
    }
  }
  if (missing.length > 0) current = insertNamedMembers(current, object, missing);
  return current;
}

/** Appends `spec` to the `plugin` array, creating the array when absent. */
/**
 * Ranges of an array's top-level elements, as [start, end) offsets into `text`.
 * A depth-and-string-aware scan, because an entry cannot be located by its
 * serialized form: the document's whitespace around commas inside the entry never
 * matches JSON.stringify's compact output.
 */
function arrayElementRanges(text, array) {
  const ranges = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let elementStart = -1;
  const push = (end) => {
    if (elementStart !== -1) {
      ranges.push([elementStart, end]);
      elementStart = -1;
    }
  };
  for (let index = array.start + 1; index < array.end - 1; index += 1) {
    const char = text[index];
    if (inString) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === '"') {
        inString = false;
        if (depth === 0) push(index + 1);
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      if (depth === 0 && elementStart === -1) elementStart = index;
      continue;
    }
    if (char === "{" || char === "[") {
      if (depth === 0 && elementStart === -1) elementStart = index;
      depth += 1;
      continue;
    }
    if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) push(index + 1);
      continue;
    }
    if (char === "," && depth === 0) {
      push(index);
      continue;
    }
  }
  return ranges;
}

function isOurPluginEntry(value, spec) {
  return typeof value === "string" ? value === spec : Array.isArray(value) && value[0] === spec;
}

/**
 * Ensures the `plugin` array contains exactly this plugin's entry, in exactly the
 * wanted shape. Both directions of drift are handled: an old bare `"file://…"`
 * entry is upgraded in place when options are now wanted, and a stale
 * `[spec, options]` entry is rewritten to the wanted options.
 */
export function ensurePluginEntry(text, spec, wanted) {
  const found = member(text, "plugin");
  if (!found) return insertNamedMembers(text, rootObjectRange(text), [["plugin", [wanted]]]);
  if (found.value.kind !== "array") throw new Error('"plugin" exists but is not an array; refusing to patch');

  const mine = [];
  for (const [start, end] of arrayElementRanges(text, found.value)) {
    const value = JSON.parse(stripJsonc(text.slice(start, end)));
    if (isOurPluginEntry(value, spec)) mine.push({ start, end, value });
  }
  if (mine.length > 1) throw new Error(`"plugin" contains ${mine.length} entries for ${spec}; refusing to patch`);
  if (mine.length === 1) {
    if (JSON.stringify(mine[0].value) === JSON.stringify(wanted)) return text;
    // Splice the exact element range, preserving every other byte of the document.
    const replaced = text.slice(0, mine[0].start) + JSON.stringify(wanted) + text.slice(mine[0].end);
    const check = member(replaced, "plugin");
    if (!check) throw new Error("plugin array vanished while replacing the entry");
    const checkEntries = JSON.parse(stripJsonc(replaced.slice(check.value.start, check.value.end)));
    if (countOurPluginEntries(checkEntries, spec) !== 1) throw new Error("plugin entry replacement did not converge");
    return replaced;
  }
  return appendArrayItem(text, found.value, wanted);
}

/** Applies every CacheSnipe setting to one config document. */
export function patchConfigText(text, options) {
  let current = text;
  current = mergeObjectAtPath(current, ["compaction"], { prune: false });
  current = mergeObjectAtPath(current, ["agent", "compaction"], {
    model: options.compactionModel,
    temperature: options.compactionTemperature,
  });
  current = setValueAtPath(current, ["small_model"], options.smallModel);
  current = ensurePluginEntry(current, options.pluginSpec, options.wantedPluginEntry ?? options.pluginSpec);
  return current;
}

/**
 * Integrity check: everything the user already had inside the objects we touch
 * must still be there. We only ever add or replace the specific keys we own.
 */
export function assertPreserved(before, after) {
  const unchanged = (label, previous, next) => {
    if (JSON.stringify(previous) !== JSON.stringify(next)) throw new Error(`${label} would change`);
  };
  for (const [key, value] of Object.entries(before?.compaction ?? {})) {
    if (key === "prune") continue;
    unchanged(`compaction.${key}`, value, after?.compaction?.[key]);
  }
  for (const [key, value] of Object.entries(before?.agent ?? {})) {
    if (key === "compaction") continue;
    unchanged(`agent.${key}`, value, after?.agent?.[key]);
  }
  for (const [key, value] of Object.entries(before?.agent?.compaction ?? {})) {
    if (key === "model" || key === "temperature") continue;
    unchanged(`agent.compaction.${key}`, value, after?.agent?.compaction?.[key]);
  }
  const nextPlugins = JSON.stringify(after?.plugin ?? []);
  for (const entry of before?.plugin ?? []) {
    if (!nextPlugins.includes(JSON.stringify(entry))) throw new Error("a plugin entry would be lost");
  }
}

export function isPatched(config, options) {
  const ours = countOurPluginEntries(config?.plugin ?? [], options.pluginSpec);
  const wanted = JSON.stringify(options.wantedPluginEntry ?? options.pluginSpec);
  const inWantedShape = (config?.plugin ?? []).some((entry) => JSON.stringify(entry) === wanted);
  return (
    config?.compaction?.prune === false &&
    config?.agent?.compaction?.model === options.compactionModel &&
    config?.agent?.compaction?.temperature === options.compactionTemperature &&
    config?.small_model === options.smallModel &&
    ours === 1 &&
    inWantedShape
  );
}

// ------------------------------------------------------------------- main ---

const options = {
  pluginSpec,
  compactionModel,
  compactionTemperature,
  smallModel,
  wantedPluginEntry: wantedPluginEntry(),
};
let exitCode = 0;

for (const file of isMain ? files : []) {
  if (!existsSync(file)) {
    console.log(`skip  ${file} (does not exist)`);
    continue;
  }
  const original = readFileSync(file, "utf8");
  let before;
  try {
    before = JSON.parse(stripJsonc(original));
  } catch (error) {
    console.error(`FAIL  ${file}: cannot parse as JSONC (${error.message}); nothing written`);
    exitCode = 1;
    continue;
  }

  if (isPatched(before, options)) {
    console.log(`ok    ${file}: already up to date`);
    continue;
  }

  let patched;
  try {
    patched = patchConfigText(original, options);
    const after = JSON.parse(stripJsonc(patched));
    if (!isPatched(after, options)) throw new Error("the patched document does not contain the expected settings");
    const afterKeys = new Set(Object.keys(after ?? {}));
    const lost = Object.keys(before ?? {}).filter((key) => !afterKeys.has(key));
    if (lost.length > 0) throw new Error(`top-level keys would be lost: ${lost.join(", ")}`);
    const beforeProviders = Object.keys(before?.provider ?? {}).length;
    const afterProviders = Object.keys(after?.provider ?? {}).length;
    if (beforeProviders !== afterProviders) throw new Error("the provider block lost entries");
    const beforeForeign = (before?.plugin ?? []).length - countOurPluginEntries(before?.plugin, pluginSpec);
    const afterForeign = (after?.plugin ?? []).length - countOurPluginEntries(after?.plugin, pluginSpec);
    if (afterForeign !== beforeForeign) throw new Error("exactly one CacheSnipe entry was expected to change");
    assertPreserved(before, after);
  } catch (error) {
    console.error(`FAIL  ${file}: ${error.message}; nothing written`);
    exitCode = 1;
    continue;
  }

  const scratch = mkdtempSync(join(tmpdir(), "cachesnipe-patch-"));
  const candidate = join(scratch, "candidate.jsonc");
  writeFileSync(candidate, patched);
  let diff = "";
  try {
    diff = execFileSync("/usr/bin/diff", ["-u", file, candidate], { encoding: "utf8" });
  } catch (error) {
    diff = error.stdout?.toString() ?? "";
  }
  rmSync(scratch, { recursive: true, force: true });

  if (dryRun) {
    console.log(`would patch ${file}`);
    console.log(diff.trimEnd());
    continue;
  }

  const backup = `${file}.bak-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}`;
  writeFileSync(backup, original);
  const tmp = `${file}.cachesnipe-tmp`;
  writeFileSync(tmp, patched);
  renameSync(tmp, file);
  console.log(`ok    ${file}: patched (backup: ${backup})`);
  console.log(diff.trimEnd());
}

if (isMain) process.exit(exitCode);
