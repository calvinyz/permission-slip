/**
 * Minimal structured logger: JSON lines to stdout and to a log file. The log file feeds
 * scripts/latency-report.ts, which measures agent round-trip times during rehearsals.
 * Secrets are redacted by key name before anything is written.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEYS = /token|secret|password|authorization|api[_-]?key|^pan$|^number$|card_number|full_number|cvv|cvc|security_code/i;

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.test(k) && typeof v === "string" ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

export function createLogger(opts: { level?: Level; file?: string; quiet?: boolean; base?: Record<string, unknown> } = {}): Logger {
  const min = ORDER[opts.level ?? "info"];
  if (opts.file) {
    try {
      mkdirSync(dirname(opts.file), { recursive: true });
    } catch {
      /* ignore */
    }
  }
  const write = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < min) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg,
      ...(redact({ ...opts.base, ...fields }) as Record<string, unknown>),
    });
    if (!opts.quiet) (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
    if (opts.file) {
      try {
        appendFileSync(opts.file, line + "\n");
      } catch {
        /* never let logging break the request path */
      }
    }
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (fields) => createLogger({ ...opts, base: { ...opts.base, ...fields } }),
  };
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};
