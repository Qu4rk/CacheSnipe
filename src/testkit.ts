import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "./log.js";
import { SessionRegistry } from "./registry.js";
import { StatsStore } from "./store.js";

/**
 * Test scaffolding. Lives under src/ so the node test runner never mistakes it
 * for a test file; nothing in the plugin imports it.
 */

/** Pass `existingDir` to simulate a second plugin instance over the same stats dir. */
export function tempContext(name = "cachesnipe", existingDir?: string) {
  const dir = existingDir ?? mkdtempSync(join(tmpdir(), `${name}-`));
  const logger = createLogger({ dir });
  const store = new StatsStore({ dir, logger, retentionDays: 30 });
  const registry = new SessionRegistry({ store, directory: "/tmp/project", logger });
  return {
    dir,
    logger,
    store,
    registry,
    cleanup: (): void => {
      if (!existingDir) rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type PromptInput = {
  date: string;
  skills?: string[] | undefined;
  mcp?: boolean | undefined;
  references?: boolean | undefined;
  cwd?: string | undefined;
  model?: string | undefined;
};

/** Mirrors the real layout produced by opencode's SystemPrompt service. */
export function systemPrompt(input: PromptInput): string[] {
  const cwd = input.cwd ?? "/tmp/project";
  const model = input.model ?? "deepseek-v4-flash";
  const parts: string[] = [
    [
      `You are powered by the model named ${model}. The exact model ID is deepseek/${model}`,
      "Here is some useful information about the environment you are running in:",
      "<env>",
      ` Working directory: ${cwd}`,
      ` Workspace root folder: ${cwd}`,
      " Is directory a git repo: yes",
      " Platform: darwin",
      ` Today's date: ${input.date}`,
      "</env>",
    ].join("\n"),
    skillsBlock(input.skills ?? ["quarkloop", "superpowers"]),
  ];
  if (input.mcp) {
    parts.push(['<mcp_instructions>', ' <server name="context7">', "  use context7 for library docs", " </server>", "</mcp_instructions>"].join("\n"));
  }
  if (input.references) {
    parts.push(
      [
        "Project references provide additional directories that can be accessed when relevant.",
        "<available_references>",
        " <reference>",
        "  <name>sibling</name>",
        "  <path>/tmp/sibling</path>",
        " </reference>",
        "</available_references>",
      ].join("\n"),
    );
  }
  return parts;
}

export function skillsBlock(names: string[]): string {
  if (names.length === 0) {
    return [
      "Skills provide specialized instructions and workflows for specific tasks.",
      "Use the skill tool to load a skill when a task matches its description.",
      "No skills are currently available.",
    ].join("\n");
  }
  return [
    "Skills provide specialized instructions and workflows for specific tasks.",
    "Use the skill tool to load a skill when a task matches its description.",
    "<available_skills>",
    ...names.flatMap((name) => [
      " <skill>",
      `  <name>${name}</name>`,
      `  <description>${name} workflow</description>`,
      `  <location>/Users/test/.config/opencode/skills/${name}/SKILL.md</location>`,
      " </skill>",
    ]),
    "</available_skills>",
  ].join("\n");
}

export function assistantMessage(input: {
  id: string;
  sessionID: string;
  input: number;
  cacheRead: number;
  output?: number;
  cost?: number;
  completed?: boolean;
  error?: string | { name?: string; data?: unknown } | null;
}): Record<string, unknown> {
  return {
    role: "assistant",
    id: input.id,
    sessionID: input.sessionID,
    providerID: "deepseek",
    modelID: "deepseek-v4-flash",
    cost: input.cost ?? 0,
    tokens: {
      input: input.input,
      output: input.output ?? 0,
      reasoning: 0,
      cache: { read: input.cacheRead, write: 0 },
    },
    time: input.completed === false ? { created: Date.now() } : { created: Date.now(), completed: Date.now() },
    ...(input.error !== undefined ? { error: input.error } : {}),
  };
}

let messageCounter = 0;

export function textMessage(input: { sessionID: string; role: "user" | "assistant"; text: string; id?: string }) {
  messageCounter += 1;
  return {
    info: { id: input.id ?? `msg_${messageCounter}`, sessionID: input.sessionID, role: input.role },
    parts: [{ type: "text", text: input.text }],
  };
}

export function toolMessage(input: { sessionID: string; callID: string; tool: string; output: string; id?: string }) {
  messageCounter += 1;
  return {
    info: { id: input.id ?? `msg_${messageCounter}`, sessionID: input.sessionID, role: "assistant" },
    parts: [
      {
        type: "tool",
        tool: input.tool,
        callID: input.callID,
        state: { status: "completed", input: { filePath: "src/a.ts" }, output: input.output, title: input.tool },
      },
    ],
  };
}
