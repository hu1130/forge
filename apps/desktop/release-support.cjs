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

function parseReleaseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(value);
  return match ? match.slice(1).map(Number) : null;
}

function isNewerRelease(candidate, current) {
  const candidateParts = parseReleaseVersion(candidate);
  const currentParts = parseReleaseVersion(current);
  if (!candidateParts || !currentParts) return false;
  for (let index = 0; index < 3; index += 1) {
    if (candidateParts[index] !== currentParts[index]) return candidateParts[index] > currentParts[index];
  }
  return false;
}

function trustedReleaseUrl(value, label = "地址") {
  let target;
  try { target = new URL(value); } catch { throw new Error(`${label}无效`); }
  const localHttp = target.protocol === "http:" && ["127.0.0.1", "localhost"].includes(target.hostname);
  if (target.protocol !== "https:" && !localHttp) throw new Error(`${label}必须使用 HTTPS`);
  return target;
}

function parseUpdateManifest(text, currentVersion) {
  if (text.length > 64 * 1024) throw new Error("更新清单超过大小限制");
  let manifest;
  try { manifest = JSON.parse(text); } catch { throw new Error("更新清单不是有效 JSON"); }
  if (!parseReleaseVersion(manifest?.version || "")) throw new Error("更新清单版本无效");
  if (!/^[A-Fa-f0-9]{64}$/.test(manifest?.sha256 || "")) throw new Error("更新清单缺少有效的 SHA-256");
  const downloadTarget = trustedReleaseUrl(manifest?.downloadUrl || "", "更新下载地址");
  return {
    available: isNewerRelease(manifest.version, currentVersion),
    version: manifest.version,
    downloadUrl: downloadTarget.href,
    sha256: manifest.sha256.toUpperCase(),
    releaseNotes: typeof manifest.releaseNotes === "string" ? manifest.releaseNotes.slice(0, 4000) : "",
  };
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

module.exports = { createReleaseLogger, isNewerRelease, parseReleaseVersion, parseUpdateManifest, redactText, redactValue, trustedReleaseUrl };
