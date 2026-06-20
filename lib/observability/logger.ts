/**
 * Structured logging (beta-hardening-001).
 *
 * Emits one JSON object per line to stdout/stderr — the format the hosting
 * platform (Vercel) and any log drain can parse and index. Dependency-free so
 * it runs unchanged in the Node and Edge runtimes (instrumentation, route
 * handlers, server actions). It NEVER throws: a logging failure must never take
 * down the request it is trying to describe.
 *
 * Sensitive values are redacted defensively before serialisation so tokens,
 * secrets, and authorization headers never reach the logs even if a caller
 * passes a context object that happens to contain them.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Arbitrary structured context attached to a log line. */
export type LogFields = Record<string, unknown>;

const REDACT_KEY = /(token|secret|password|authorization|api[-_]?key|cookie)/i;
const REDACTED = "[redacted]";

/**
 * Shallowly (one level deep) replace the values of sensitive-looking keys with
 * a placeholder. Pure; returns a new object and never mutates the input.
 */
function redact(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (REDACT_KEY.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested: LogFields = {};
      for (const [k, v] of Object.entries(value as LogFields)) {
        nested[k] = REDACT_KEY.test(k) ? REDACTED : v;
      }
      out[key] = nested;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * Build the structured record for a log line. Exposed (not just `log`) so unit
 * tests can assert the shape without capturing console output. `now` is
 * injectable for deterministic tests.
 */
export function buildLogRecord(
  level: LogLevel,
  message: string,
  fields: LogFields = {},
  now: Date = new Date(),
): Record<string, unknown> {
  return {
    level,
    msg: message,
    ts: now.toISOString(),
    service: "alpha-crm",
    ...redact(fields),
  };
}

/** Emit a structured log line. Errors → stderr; everything else → stdout. */
export function log(level: LogLevel, message: string, fields: LogFields = {}): void {
  let line: string;
  try {
    line = JSON.stringify(buildLogRecord(level, message, fields));
  } catch {
    // A non-serialisable field (e.g. a circular reference) must not crash the
    // caller — fall back to a minimal, guaranteed-serialisable record.
    line = JSON.stringify({ level, msg: message, service: "alpha-crm" });
  }
  // eslint-disable-next-line no-console
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  sink(line);
}

export const logger = {
  debug: (message: string, fields?: LogFields) => log("debug", message, fields),
  info: (message: string, fields?: LogFields) => log("info", message, fields),
  warn: (message: string, fields?: LogFields) => log("warn", message, fields),
  error: (message: string, fields?: LogFields) => log("error", message, fields),
};
