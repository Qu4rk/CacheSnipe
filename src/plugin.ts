import type { Config, Hooks, Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin";
import { execFile } from "node:child_process";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { createCompactingHook } from "./compaction.js";
import { createSystemTransform } from "./freeze.js";
import { createMessagesTransform } from "./guard.js";
import { createLogger, type Logger, type LogSink } from "./log.js";
import { SessionRegistry } from "./registry.js";
import type { ConfigSnapshot } from "./render.js";
import { StatsStore } from "./store.js";
import { createEventHandler } from "./telemetry.js";
import type { Verdict } from "./types.js";
import type { ResolvedOptions } from "./types.js";

/**
 * CacheSnipe — DeepSeek prompt-cache plugin for OpenCode.
 *
 * Hooks used (all `experimental.*` ones are optional; telemetry works through
 * plain events, so an opencode build without them degrades instead of breaking):
 *
 *   config                                  P3 auditing: prune flag, compaction model/temp, small_model
 *   experimental.chat.system.transform      P0 date freeze, P0b prompt-block freeze/attribution
 *   experimental.chat.messages.transform    P2 prefix guard (rewind vs divergence)
 *   experimental.session.compacting         P3 deterministic compaction context
 *   event                                   P1 telemetry from assistant message accounting
 *
 * Runtime note: the OpenCode Desktop app hosts the server inside an Electron
 * Node process (no Bun), so this file uses `node:*` builtins only and is loaded
 * as compiled JavaScript — never `$`/`Bun.*`, never a raw `.ts` import.
 */

export const PLUGIN_ID = "cachesnipe";
export const PLUGIN_VERSION = "0.1.0";
export const DEFAULT_STATS_DIR = join(homedir(), ".local", "share", "opencode", "deepseek-cache");

export const OPTIONAL_HOOKS = [
  "experimental.chat.system.transform",
  "experimental.chat.messages.transform",
  "experimental.session.compacting",
] as const;

const DEFAULT_OPTIONS: ResolvedOptions = {
  enabled: true,
  providers: [],
  models: [],
  statsDir: DEFAULT_STATS_DIR,
  retentionDays: 30,
  strictFreeze: false,
  compactionPrompt: "context",
  notifications: false,
  sessionTitle: false,
};

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : JSON.stringify(error);
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string" && value.length > 0) return [value];
  return [];
}

export function resolveOptions(raw?: PluginOptions): ResolvedOptions {
  const input = (raw ?? {}) as Record<string, unknown>;
  const mode = input["compactionPrompt"];
  return {
    enabled: bool(input["enabled"], DEFAULT_OPTIONS.enabled),
    providers: stringList(input["providers"]),
    models: stringList(input["models"]),
    statsDir: typeof input["statsDir"] === "string" && input["statsDir"] ? input["statsDir"] : DEFAULT_OPTIONS.statsDir,
    retentionDays:
      typeof input["retentionDays"] === "number" && input["retentionDays"] > 0
        ? input["retentionDays"]
        : DEFAULT_OPTIONS.retentionDays,
    strictFreeze: bool(input["strictFreeze"], DEFAULT_OPTIONS.strictFreeze),
    compactionPrompt: mode === "replace" || mode === "off" || mode === "context" ? mode : DEFAULT_OPTIONS.compactionPrompt,
    notifications: bool(input["notifications"], DEFAULT_OPTIONS.notifications),
    sessionTitle: bool(input["sessionTitle"], DEFAULT_OPTIONS.sessionTitle),
  };
}

function makeSink(input: PluginInput): LogSink | undefined {
  const app = (input.client as unknown as { app?: { log?: (options: unknown) => unknown } }).app;
  if (!app || typeof app.log !== "function") return undefined;
  const log = app.log.bind(app);
  return (level, message, extra) => {
    try {
      void Promise.resolve(
        log({
          body: {
            service: PLUGIN_ID,
            level,
            message,
            extra: { ...extra, plugin: `${PLUGIN_ID}@${PLUGIN_VERSION}` },
          },
        }),
      ).catch(() => undefined);
    } catch {
      // The file log already has the line.
    }
  };
}

function notify(logger: Logger, title: string, message: string): void {
  if (platform() !== "darwin") return;
  const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`;
  try {
    execFile("/usr/bin/osascript", ["-e", script], { timeout: 5_000 }, (error) => {
      if (error) logger.debug("notification failed", { error: error.message });
    });
  } catch (error) {
    logger.debug("notification failed", { error: describeError(error) });
  }
}

function wrap<F extends (...args: any[]) => Promise<any>>(name: string, fn: F, logger: Logger): F {
  const wrapped = async (...args: Parameters<F>): Promise<void> => {
    try {
      await fn(...args);
    } catch (error) {
      logger.error(`${name} hook failed`, { error: describeError(error) });
    }
  };
  return wrapped as unknown as F;
}

export function captureConfig(cfg: Config, options: ResolvedOptions, logger: Logger): ConfigSnapshot {
  const root = cfg as unknown as Record<string, unknown>;
  const compaction = (root["compaction"] ?? {}) as Record<string, unknown>;
  const agents = (root["agent"] ?? {}) as Record<string, unknown>;
  const compactionAgent = (agents["compaction"] ?? {}) as Record<string, unknown>;
  const prune = typeof compaction["prune"] === "boolean" ? compaction["prune"] : undefined;
  const snapshot: ConfigSnapshot = {
    prune,
    compactionModel: typeof compactionAgent["model"] === "string" ? compactionAgent["model"] : undefined,
    compactionTemperature:
      typeof compactionAgent["temperature"] === "number" ? compactionAgent["temperature"] : undefined,
    smallModel: typeof root["small_model"] === "string" ? root["small_model"] : undefined,
    strictFreeze: options.strictFreeze,
    notifications: options.notifications,
    capturedAt: Date.now(),
  };

  logger.info("config captured", {
    prune: snapshot.prune === undefined ? "(unset)" : snapshot.prune,
    compactionModel: snapshot.compactionModel ?? "(default)",
    compactionTemperature: snapshot.compactionTemperature ?? "(default)",
    smallModel: snapshot.smallModel ?? "(unset)",
  });
  if (prune !== false) {
    logger.warn(
      "compaction.prune is not disabled: opencode may rewrite old tool outputs mid-session, which moves the cached prefix",
      { prune: prune ?? "(unset)", fix: 'set "compaction": { "prune": false } in opencode.json' },
    );
  }
  if (snapshot.compactionTemperature === undefined) {
    logger.info("compaction agent has no explicit temperature; temperature 0 is recommended for deterministic summaries");
  }
  return snapshot;
}

export const server: Plugin = async (input: PluginInput, rawOptions?: PluginOptions): Promise<Hooks> => {
  const options = resolveOptions(rawOptions);
  const logger = createLogger({ dir: options.statsDir, sink: makeSink(input) });

  if (!options.enabled) {
    logger.info("cachesnipe disabled by options");
    return {};
  }

  const store = new StatsStore({ dir: options.statsDir, logger, retentionDays: options.retentionDays });
  const registry = new SessionRegistry({ store, directory: input.directory, logger });
  let config: ConfigSnapshot | undefined;

  const fired = { system: false, messages: false, compaction: false, event: false, request: false };
  /** Shortened by tests so the diagnostic window can be exercised without a 20s wait. */
  const diagnosticWindowMs = (() => {
    const raw = Number(process.env["CACHESNIPE_DIAGNOSTIC_MS"] ?? process.env["CACHE_HITTER_DIAGNOSTIC_MS"]);
    return Number.isFinite(raw) && raw > 0 ? raw : 20_000;
  })();
  let diagnosticsTimer: ReturnType<typeof setTimeout> | undefined;
  let diagnosticsVerdict: "active" | "missing" | undefined;

  const updateSessionTitle = async (sessionID: string, rate: number): Promise<void> => {
    const session = (input.client as unknown as {
      session?: {
        get?: (options: { path: { id: string } }) => Promise<{ data?: { title?: string } } | undefined>;
        update?: (options: { path: { id: string }; body: { title: string } }) => Promise<unknown>;
      };
    }).session;
    if (!session?.get || !session.update) return;
    try {
      const current = await session.get({ path: { id: sessionID } });
      const title = current?.data?.title ?? "";
      const stripped = title.replace(/\s*\[cache [\d.]+%\]$/, "");
      await session.update({ path: { id: sessionID }, body: { title: `${stripped} [cache ${(rate * 100).toFixed(0)}%]` } });
    } catch (error) {
      logger.debug("session title update failed", { sessionID, error: describeError(error) });
    }
  };

  const reportHooksActive = (): void => {
    if (diagnosticsTimer) {
      clearTimeout(diagnosticsTimer);
      diagnosticsTimer = undefined;
    }
    if (diagnosticsVerdict === "active") return;
    if (diagnosticsVerdict === "missing") {
      // Retract the earlier verdict rather than leaving a misleading line in the log.
      logger.info("experimental hooks became active after all", {
        systemTransform: fired.system,
        messagesTransform: fired.messages,
      });
    }
    diagnosticsVerdict = "active";
    logger.info("all hooks active", {
      systemTransform: fired.system,
      messagesTransform: fired.messages,
      compaction: fired.compaction,
    });
  };

  /**
   * Diagnostics for an opencode build without the `experimental.chat.*` hooks.
   *
   * The window opens on the first *request* (an assistant message), never on the
   * first event: events flow from unrelated activity long before a request, so
   * arming on events produced a false "hooks never fired" warning twenty seconds
   * after load, while the user had not sent anything yet. Observed live on
   * 2026-09-16 — the hooks fired a minute later.
   */
  const scheduleHookDiagnostics = (): void => {
    if (!fired.request || diagnosticsTimer || diagnosticsVerdict !== undefined) return;
    const timer = setTimeout(() => {
      diagnosticsTimer = undefined;
      if (diagnosticsVerdict !== undefined) return;
      if (fired.system && fired.messages) {
        reportHooksActive();
        return;
      }
      diagnosticsVerdict = "missing";
      logger.warn("a request went out but experimental hooks never fired", {
        systemTransform: fired.system,
        messagesTransform: fired.messages,
        windowMs: diagnosticWindowMs,
        note: "opencode builds without experimental.chat.* hooks degrade to telemetry-only (P1)",
      });
    }, diagnosticWindowMs);
    timer.unref?.();
    diagnosticsTimer = timer;
  };

  const noteHookActivity = (): void => {
    if (fired.system && fired.messages) reportHooksActive();
  };

  /**
   * True only for a message that represents a request happening now. On app start
   * opencode re-emits `message.updated` for existing assistant messages as it
   * reloads the session; counting those armed the diagnostic window with no request
   * in flight, which produced a warning 20s after a restart (observed 2026-09-16)
   * that then had to retract itself.
   */
  const isLiveRequest = (time: { created?: number; completed?: number } | undefined): boolean => {
    if (time?.completed === undefined) return true;
    return typeof time.created === "number" && Date.now() - time.created < 15_000;
  };

  const systemTransform = createSystemTransform({
    registry,
    logger,
    options,
    onPromptBreak: (sessionID, summary) => {
      if (options.notifications) notify(logger, "CacheSnipe: prompt prefix changed", summary.slice(0, 200));
    },
  });

  const messagesTransform = createMessagesTransform({
    registry,
    logger,
    onBreak: (sessionID: string, verdict: Verdict) => {
      if (options.notifications) {
        notify(
          logger,
          "CacheSnipe: cache prefix broken",
          `message ${verdict.index} changed (${verdict.detail ?? "unknown cause"})`,
        );
      }
    },
  });

  const compactionHook = createCompactingHook({
    registry,
    logger,
    options,
    getConfig: () => config,
    onCompaction: () => {
      fired.compaction = true;
    },
  });

  const eventHook = createEventHandler({
    registry,
    logger,
    options,
    onMilestone: (sessionID, rate, milestone) => {
      if (options.notifications) {
        notify(logger, `CacheSnipe: ${(milestone * 100).toFixed(0)}% cache hit`, `warm hit rate ${(rate * 100).toFixed(1)}%`);
      }
      if (options.sessionTitle) void updateSessionTitle(sessionID, rate);
    },
  });

  const hooks: Hooks = {
    "config": wrap("config", async (cfg: Config) => {
      config = captureConfig(cfg, options, logger);
      store.writeConfig(config);
      store.writeDerived();
    }, logger),

    "experimental.chat.system.transform": wrap("experimental.chat.system.transform", async (hookInput, hookOutput) => {
      fired.system = true;
      noteHookActivity();
      await systemTransform(hookInput, hookOutput);
    }, logger),

    "experimental.chat.messages.transform": wrap("experimental.chat.messages.transform", async (hookInput, hookOutput) => {
      fired.messages = true;
      noteHookActivity();
      await messagesTransform(hookInput, hookOutput);
    }, logger),

    "experimental.session.compacting": wrap("experimental.session.compacting", async (hookInput, hookOutput) => {
      fired.compaction = true;
      await compactionHook(hookInput, hookOutput);
    }, logger),

    "event": wrap("event", async (hookInput) => {
      fired.event = true;
      const event = (
        hookInput as {
          event?: { type?: string; properties?: { info?: { role?: string; time?: { created?: number; completed?: number } } } };
        }
      ).event;
      const info = event?.type === "message.updated" ? event.properties?.info : undefined;
      if (info?.role === "assistant" && isLiveRequest(info.time)) fired.request = true;
      scheduleHookDiagnostics();
      await eventHook(hookInput);
    }, logger),

    "dispose": async () => {
      registry.flush();
      store.flushAll();
      store.writeDerived();
      logger.info("cachesnipe disposed");
    },
  };

  const removed = store.cleanup();
  store.writeDerived();
  logger.info(`cachesnipe ${PLUGIN_VERSION} loaded`, {
    directory: input.directory,
    worktree: input.worktree,
    statsDir: options.statsDir,
    log: logger.file,
    options: {
      strictFreeze: options.strictFreeze,
      compactionPrompt: options.compactionPrompt,
      notifications: options.notifications,
      sessionTitle: options.sessionTitle,
      retentionDays: options.retentionDays,
      providers: options.providers,
      models: options.models,
    },
    hooks: Object.keys(hooks),
    prunedSessions: removed,
    opencodeHooks:
      "P1 telemetry needs only `event`; P0/P0b/P2/P3 need the experimental.chat.* hooks",
  });

  return hooks;
};

export default { id: PLUGIN_ID, server };
