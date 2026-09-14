import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Windows release uses Forge branding and exposes privacy-safe diagnostics", async () => {
  const [desktopPackage, icon, main, releaseSupport, releaseVerifier, preload, rendererTypes] = await Promise.all([
    readFile(new URL("../apps/desktop/package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../apps/desktop/assets/forge-icon.ico", import.meta.url)),
    readFile(new URL("../apps/desktop/main.cjs", import.meta.url), "utf8"),
    readFile(new URL("../apps/desktop/release-support.cjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/verify-release.mjs", import.meta.url), "utf8"),
    readFile(new URL("../apps/desktop/preload.cjs", import.meta.url), "utf8"),
    readFile(new URL("../apps/web/src/desktop.d.ts", import.meta.url), "utf8"),
  ]);

  assert.equal(desktopPackage.build.win.icon, "assets/forge-icon.ico");
  assert.equal(desktopPackage.build.nsis.installerIcon, "assets/forge-icon.ico");
  assert.ok(desktopPackage.build.files.includes("release-support.cjs"));
  assert.equal(icon.readUInt16LE(0), 0);
  assert.equal(icon.readUInt16LE(2), 1);
  assert.ok(icon.readUInt16LE(4) >= 7);
  assert.match(main, /forge:export-diagnostics/);
  assert.match(main, /recentLifecycle: lifecycleLogger\?\.recent\(100\)/);
  assert.match(main, /stdio: "ignore"/);
  assert.match(main, /不包含 API Key、MCP Token、邮箱、租户 ID、工作区路径、任务或对话内容/);
  assert.doesNotMatch(main, /configuration:\s*\{[^}]*tenantId/s);
  assert.match(releaseSupport, /REDACTED_API_KEY/);
  assert.match(releaseSupport, /REDACTED_TOKEN/);
  assert.match(releaseVerifier, /Authenticode signature/);
  assert.match(releaseVerifier, /commercial \? "fail" : "warn"/);
  assert.match(preload, /exportDiagnostics/);
  assert.match(rendererTypes, /exportDiagnostics/);
});
