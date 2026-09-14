import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("commercial foundation gates first use on versioned local legal consent", async () => {
  const [profile, main, preload, app, dialog, documents] = await Promise.all([
    readFile("apps/desktop/release-profile.json", "utf8").then(JSON.parse),
    readFile("apps/desktop/main.cjs", "utf8"),
    readFile("apps/desktop/preload.cjs", "utf8"),
    readFile("apps/web/src/App.tsx", "utf8"),
    readFile("apps/web/src/LegalConsentDialog.tsx", "utf8"),
    readFile("apps/web/src/LegalDocuments.tsx", "utf8"),
  ]);

  assert.equal(profile.legalVersion, "2026-09-14");
  assert.equal(profile.publisherName, "");
  assert.match(main, /forge:release-info/);
  assert.match(main, /forge:accept-legal/);
  assert.match(main, /legalConsent = \{ version, acceptedAt:/);
  assert.match(main, /FORGE_PORT: String\(daemonPort\)/);
  assert.match(main, /probeLocalPort\(0\)/);
  assert.doesNotMatch(main, /fetch\("http:\/\/127\.0\.0\.1:4782/);
  assert.match(preload, /acceptLegalTerms/);
  assert.match(app, /!releaseInfo\.legalAccepted/);
  assert.match(dialog, /type="checkbox"/);
  assert.match(dialog, /aria-modal="true"/);
  assert.match(dialog, /同意并继续/);
  assert.match(documents, /用户应使用自己有权使用的模型 API 账户和密钥/);
  assert.match(documents, /诊断文件仅在用户主动导出时生成/);
});

test("manual update checks validate HTTPS and SHA-256 without silent installation", async () => {
  const [main, support, settings, upgrade] = await Promise.all([
    readFile("apps/desktop/main.cjs", "utf8"),
    readFile("apps/desktop/release-support.cjs", "utf8"),
    readFile("apps/web/src/ReleaseSettings.tsx", "utf8"),
    readFile("scripts/verify-windows-upgrade.ps1", "utf8"),
  ]);

  assert.match(main, /redirect: "error"/);
  assert.match(main, /AbortSignal\.timeout\(12_000\)/);
  assert.match(support, /64 \* 1024/);
  assert.match(support, /必须使用 HTTPS/);
  assert.match(support, /\{64\}/);
  assert.match(settings, /打开下载页/);
  assert.doesNotMatch(main, /autoUpdater|quitAndInstall/);
  assert.match(upgrade, /FORGE_CLEAN_VM/);
  assert.match(upgrade, /User data was removed during the upgrade/);
  assert.match(upgrade, /Uninstall unexpectedly removed user data/);
});
