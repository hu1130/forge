const {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} = require("node:fs");
const path = require("node:path");

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_RECENT_LIMIT = 100;
const SENSITIVE_KEY = /(api.?key|authorization|cookie|email|password|path|secret|tenant.?id|token|user.?id|workspace)/i;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactText(value, options = {}) {
  let result = String(value ?? "");
  if (options.homePath) result = result.replace(new RegExp(escapeRegExp(String(options.homePath)), "gi"), "%USERPROFILE%");
  return result
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[REDACTED_API_KEY]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED_TOKEN]")
    .replace(/\b(api[_-]?key|password|secret|token)\s*[=:]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/[A-Z]:\\(?:[^\\\s]+\\)*[^\\\s]*/gi, "[REDACTED_PATH]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[REDACTED_ID]")
    .slice(0, 1000);
}

function redactValue(value, options = {}, key = "") {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactText(value, options);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactValue(item, options));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 30).map(([childKey, childValue]) => [childKey, redactValue(childValue, options, childKey)]));
  }
  return redactText(value, options);
}

function createReleaseLogger({ logDir, homePath = "", maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!logDir) throw new Error("logDir is required");
  mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, "forge.log");
  const previousLogPath = `${logPath}.1`;
  const redactionOptions = { homePath };

  function rotateIfNeeded(nextBytes) {
    if (!existsSync(logPath) || statSync(logPath).size + nextBytes <= maxBytes) return;
    if (existsSync(previousLogPath)) unlinkSync(previousLogPath);
    renameSync(logPath, previousLogPath);
  }

  function write(event, details = {}) {
    const entry = {
      at: new Date().toISOString(),
      event: redactText(event, redactionOptions).slice(0, 80),
      details: redactValue(details, redactionOptions),
    };
    const line = `${JSON.stringify(entry)}\n`;
    rotateIfNeeded(Buffer.byteLength(line));
    appendFileSync(logPath, line, { encoding: "utf8", mode: 0o600 });
  }

  function recent(limit = DEFAULT_RECENT_LIMIT) {
    const normalizedLimit = Math.max(1, Math.min(Number(limit) || DEFAULT_RECENT_LIMIT, 200));
    const paths = [previousLogPath, logPath].filter(existsSync);
    const lines = paths.flatMap((filePath) => readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean));
    return lines.slice(-normalizedLimit).flatMap((line) => {
      try { return [redactValue(JSON.parse(line), redactionOptions)]; } catch { return []; }
    });
  }

  return { logPath, previousLogPath, recent, write };
}

module.exports = { createReleaseLogger, redactText, redactValue };
