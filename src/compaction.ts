import type { Hooks } from "@opencode-ai/plugin";
import type { Logger } from "./log.js";
import type { SessionRegistry } from "./registry.js";
import type { ConfigSnapshot } from "./render.js";
import type { ResolvedOptions } from "./types.js";

/**
   * L3 — deterministic compaction.
 *
 * opencode compacts through a dedicated `compaction` agent, so the model and
 * temperature come from config:
 *
 *   "agent":       { "compaction": { "model": "deepseek/deepseek-v4-flash", "temperature": 0 } }
 *   "compaction":  { "prune": false }
 *
 * What is left for the plugin is prompt stability and auditability:
 *  - it logs the compaction event together with the *configured* model,
 *    temperature and prune flag (the hook input only carries a session id, so
 *    this is how criterion 5 is provable from the log);
 *  - it optionally injects a static context block that tells the summarizer to
 *    preserve the facts a continuation needs, with no timestamps or other
 *    per-turn values (`compactionPrompt: "context"`, the default);
 *  - `compactionPrompt: "replace"` swaps in a full deterministic prompt instead,
 *    and `"off"` leaves opencode's own prompt untouched.
 *
 * The original extension also carried a SHA-256 summary cache; opencode compacts
 * once per event with no replays to dedupe, so it is intentionally dropped.
 */

export const COMPACTION_CONTEXT = [
  "## CacheSnipe continuity notes",
  "Preserve these verbatim where possible so the continuation keeps a stable prefix:",
  "- the current task and its acceptance criteria",
  "- files created or modified, with absolute paths, and what changed in each",
  "- decisions taken, the reason for them, and alternatives rejected",
  "- the exact next action, plus any command that must be re-run",
  "Do not include timestamps, dates, relative times, or any other value that changes between turns.",
].join("\n");

export const COMPACTION_PROMPT = [
  "You are producing a continuation prompt that lets a fresh agent resume this session exactly.",
  "",
  "Write it as a single deterministic document with these sections, in this order:",
  "1. Task and acceptance criteria (verbatim where quoted by the user).",
  "2. State of the work: files created or modified with absolute paths and what each change does.",
  "3. Decisions and rationale, including rejected alternatives and any constraint that is easy to forget.",
  "4. Verification status: what has been run, what passed, what is still unproven.",
  "5. Next action, stated as a concrete instruction.",
  "",
  "Rules: no timestamps, no dates, no relative time references, no speculative commentary about the",
  "conversation itself. Prefer exact identifiers, paths and commands over paraphrases. Do not summarise",
  "tool output that has no bearing on the next action.",
].join("\n");

export type CompactionDeps = {
  registry: SessionRegistry;
  logger: Logger;
  options: ResolvedOptions;
  getConfig: () => ConfigSnapshot | undefined;
  onCompaction?: (sessionID: string, info: { model: string; temperature: number | undefined; prune: boolean | undefined }) => void;
};

export function createCompactingHook(deps: CompactionDeps): NonNullable<Hooks["experimental.session.compacting"]> {
  const { registry, logger, options } = deps;

  return async (input, output): Promise<void> => {
    const session = registry.observe(input.sessionID);
    session.pendingCompaction = true;
    const stats = session.stats;
    const config = deps.getConfig();
    const model = config?.compactionModel ?? "(config default)";
    const temperature = config?.compactionTemperature;
    const prune = config?.prune;

    if (stats) {
      registry.note(session, `compaction requested with ${model}${temperature === undefined ? "" : ` @ temp ${temperature}`}`);
      registry.markDirty(session);
    }

    logger.info("compaction starting", {
      sessionID: input.sessionID,
      mode: options.compactionPrompt,
      model,
      temperature: temperature ?? "(default)",
      prune: prune === undefined ? "(unset)" : prune,
      pruneWarning: prune !== false ? "prune is enabled: it rewrites old tool outputs and breaks the prefix" : undefined,
    });

    if (options.compactionPrompt === "replace") {
      output.prompt = COMPACTION_PROMPT;
    } else if (options.compactionPrompt === "context") {
      output.context.push(COMPACTION_CONTEXT);
    }

    deps.onCompaction?.(input.sessionID, { model, temperature, prune });
  };
}
