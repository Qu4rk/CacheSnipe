import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LogLevel } from "./types.js";

/**
 * Logging.
 *
 * Two constraints shaped this file:
 *  - The port must run inside opencode's server, which in the Desktop app is an
 *    Electron Node process: only `node:*` builtins are safe here.
 *  - A logging failure must never take a session down, so every filesystem call
 *    is wrapped and swallowed.
 *
 * Lines go to `<statsDir>/cachesnipe.log` (rotated once at 2 MB) and, when the
 * SDK client exposes `app.log`, to the opencode server log as well.
 */

const MAX_LOG_BYTES = 2 * 1024 * 1024;

export type LogSink = (level: LogLevel, message: string, extra?: Record<string, unknown>) => void;

export type Logger = {
  readonly file: string;
  debug(message: string, extra?: Record<string, unknown>): void;
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
};

function rotateIfLarge(file: string): void {
  try {
    if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.1`);
  } catch {
    // Missing file or unwritable directory: rotation is best-effort.
  }
}

function serialize(extra?: Record<string, unknown>): string {
  if (!extra) return "";
  try {
    const seen = new WeakSet<object>();
    return ` ${JSON.stringify(extra, (_key, value: unknown) => {
      if (typeof value === "bigint") return value.toString();
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[circular]";
        seen.add(value);
      }
      return value;
    })}`;
  } catch {
    return " [unserializable]";
  }
}

export function createLogger(input: {
  dir: string;
  fileName?: string;
  sink?: LogSink;
  mirrorToConsole?: boolean;
}): Logger {
  const fileName = input.fileName ?? "cachesnipe.log";
  let file = join(input.dir, fileName);

  try {
    mkdirSync(input.dir, { recursive: true });
  } catch {
    // Fall through: the logger still mirrors to the console sink.
  }
  rotateIfLarge(file);

  const write = (level: LogLevel, message: string, extra?: Record<string, unknown>): void => {
    const line = `${new Date().toISOString()} level=${level.toUpperCase()} service=cachesnipe ${message}${serialize(extra)}`;
    try {
      appendFileSync(file, `${line}\n`);
    } catch {
      // Best effort only.
    }
    if (input.mirrorToConsole) {
      // eslint-disable-next-line no-console
      console.error(`[cachesnipe] ${line}`);
    }
    try {
      input.sink?.(level, message, extra);
    } catch {
      // A failing sink must not break logging.
    }
  };

  const logger: Logger = {
    get file() {
      return file;
    },
    debug: (message, extra) => write("debug", message, extra),
    info: (message, extra) => write("info", message, extra),
    warn: (message, extra) => write("warn", message, extra),
    error: (message, extra) => write("error", message, extra),
  };
  return logger;
}
