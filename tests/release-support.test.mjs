import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import releaseSupport from "../apps/desktop/release-support.cjs";

const { createReleaseLogger, isNewerRelease, parseUpdateManifest, redactText, trustedReleaseUrl } = releaseSupport;

test("release logger redacts secrets, identities, emails, and local paths", async (context) => {
  const logDir = await mkdtemp(path.join(os.tmpdir(), "forge-release-log-"));
  context.after(() => rm(logDir, { recursive: true, force: true }));
  const homePath = "C:\\Users\\Example";
  const logger = createReleaseLogger({ logDir, homePath });

  logger.write("daemon.error", {
    message: "Bearer private-token sk-example1234567890 from C:\\Users\\Example\\project",
    email: "person@example.com",
    tenantId: "118b71fc-4d4e-4d5c-b607-646f2f02ff3a",
  });

  const contents = await readFile(logger.logPath, "utf8");
  assert.doesNotMatch(contents, /private-token|sk-example|person@example\.com|118b71fc|Example\\project/);
  assert.match(contents, /REDACTED_TOKEN/);
  assert.match(contents, /REDACTED_API_KEY/);
  assert.deepEqual(logger.recent(1)[0].details.email, "[REDACTED]");
});

test("release logger rotates bounded logs and reads recent structured entries", async (context) => {
  const logDir = await mkdtemp(path.join(os.tmpdir(), "forge-release-rotate-"));
  context.after(() => rm(logDir, { recursive: true, force: true }));
  const logger = createReleaseLogger({ logDir, maxBytes: 180 });

  logger.write("first", { message: "a".repeat(100) });
  logger.write("second", { ok: true });

  assert.equal((await readFile(logger.previousLogPath, "utf8")).includes('"event":"first"'), true);
  assert.equal(logger.recent(1)[0].event, "second");
});

test("diagnostic redaction also handles standalone sensitive text", () => {
  const result = redactText("api_key=secret123 password:open-sesame user@forge.example");
  assert.doesNotMatch(result, /secret123|open-sesame|user@forge\.example/);
});

test("release versions and update manifests reject unsafe downloads", () => {
  assert.equal(isNewerRelease("0.23.0", "0.22.1"), true);
  assert.equal(isNewerRelease("0.22.1", "0.22.1"), false);
  assert.throws(() => trustedReleaseUrl("http://downloads.example.com/Forge.exe", "下载地址"), /HTTPS/);
  assert.doesNotThrow(() => trustedReleaseUrl("http://127.0.0.1:8080/Forge.exe", "下载地址"));
  assert.throws(() => parseUpdateManifest(JSON.stringify({ version: "0.23.0", downloadUrl: "https://example.com/Forge.exe", sha256: "bad" }), "0.22.1"), /SHA-256/);
  const manifest = parseUpdateManifest(JSON.stringify({
    version: "0.23.0",
    downloadUrl: "https://downloads.example.com/Forge-Setup-0.23.0.exe",
    sha256: "a".repeat(64),
    releaseNotes: "商业版基础",
  }), "0.22.1");
  assert.equal(manifest.available, true);
  assert.equal(manifest.sha256, "A".repeat(64));
});
