import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex").toUpperCase();
}

function packageJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repositoryRoot, relativePath), "utf8"));
}

function windowsMetadata(filePath) {
  if (process.platform !== "win32") return null;
  const command = [
    "Import-Module Microsoft.PowerShell.Security -ErrorAction Stop",
    "$item = Get-Item -LiteralPath $env:FORGE_VERIFY_INSTALLER",
    "$signature = Get-AuthenticodeSignature -LiteralPath $env:FORGE_VERIFY_INSTALLER",
    "[pscustomobject]@{ productVersion = $item.VersionInfo.ProductVersion; signature = $signature.Status.ToString() } | ConvertTo-Json -Compress",
  ].join("; ");
  let result;
  for (const executable of ["pwsh.exe", "powershell.exe"]) {
    result = spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Command", command], {
      encoding: "utf8",
      env: { ...process.env, FORGE_VERIFY_INSTALLER: filePath },
    });
    if (!result.error || result.error.code !== "ENOENT") break;
  }
  if (result.error) return { error: result.error.message };
  if (result.status !== 0) return { error: (result.stderr || result.stdout || "PowerShell metadata check failed").trim() };
  try { return JSON.parse(result.stdout.trim()); } catch { return { error: "PowerShell returned invalid metadata" }; }
}

export function verifyRelease({ expectedVersion, commercial = false } = {}) {
  const rootPackage = packageJson("package.json");
  const version = expectedVersion || rootPackage.version;
  const desktopPackage = packageJson("apps/desktop/package.json");
  const results = [];
  const add = (level, label, detail) => results.push({ level, label, detail });
  const requireFile = (relativePath, minimumBytes = 1) => {
    const absolutePath = path.join(repositoryRoot, relativePath);
    if (!existsSync(absolutePath)) return add("fail", labelFor(relativePath), "missing");
    const stats = statSync(absolutePath);
    if (!stats.isFile() || stats.size < minimumBytes) return add("fail", labelFor(relativePath), `invalid size (${stats.size} bytes)`);
    add("pass", labelFor(relativePath), `${stats.size.toLocaleString("en-US")} bytes`);
  };

  for (const relativePath of ["package.json", "apps/desktop/package.json", "apps/web/package.json", "apps/daemon/package.json", "apps/cloud-api/package.json"]) {
    const actual = packageJson(relativePath).version;
    add(actual === version ? "pass" : "fail", `${relativePath} version`, actual);
  }

  const versionSources = [
    ["apps/cloud-api/src/server.ts", `version: "${version}"`],
    ["apps/cloud-api/src/email-delivery.ts", `Forge-Cloud/${version}`],
  ];
  for (const [relativePath, marker] of versionSources) {
    const found = readFileSync(path.join(repositoryRoot, relativePath), "utf8").includes(marker);
    add(found ? "pass" : "fail", `${relativePath} release marker`, marker);
  }

  const desktopFiles = desktopPackage.build?.files || [];
  add(desktopFiles.includes("release-support.cjs") ? "pass" : "fail", "desktop support module", "release-support.cjs bundled");
  requireFile("apps/desktop/assets/forge-icon.ico", 1024);

  const installerRelativePath = `release/Forge-Setup-${version}.exe`;
  const installerPath = path.join(repositoryRoot, installerRelativePath);
  requireFile(installerRelativePath, 1024 * 1024);
  requireFile("release/win-unpacked/Forge.exe", 1024 * 1024);
  requireFile("release/win-unpacked/resources/app.asar", 1024);
  requireFile("release/win-unpacked/resources/web/index.html", 100);
  requireFile("release/win-unpacked/resources/daemon/server.mjs", 1024);
  requireFile("release/win-unpacked/resources/codex/codex.exe", 1024 * 1024);
  requireFile("release/win-unpacked/resources/codex/VERSION.txt", 10);
  requireFile("release/win-unpacked/resources/licenses/Codex-LICENSE.txt", 1000);
  requireFile("release/win-unpacked/resources/licenses/THIRD_PARTY_NOTICES.md", 100);
  const appArchivePath = path.join(repositoryRoot, "release/win-unpacked/resources/app.asar");
  if (existsSync(appArchivePath)) {
    const appArchive = readFileSync(appArchivePath);
    for (const marker of ["main.cjs", "preload.cjs", "release-support.cjs"]) {
      add(appArchive.includes(Buffer.from(marker)) ? "pass" : "fail", `app.asar contains ${marker}`, "embedded filename found");
    }
  }

  if (existsSync(installerPath)) {
    add("pass", "installer SHA-256", sha256(installerPath));
    const metadata = windowsMetadata(installerPath);
    if (metadata?.error) {
      add(commercial ? "fail" : "warn", "Windows metadata", metadata.error);
    } else if (metadata) {
      const versionMatches = String(metadata.productVersion || "").startsWith(version);
      add(versionMatches ? "pass" : "fail", "installer product version", metadata.productVersion || "missing");
      const signed = metadata.signature === "Valid";
      add(signed ? "pass" : commercial ? "fail" : "warn", "Authenticode signature", metadata.signature || "Unknown");
    } else {
      add(commercial ? "fail" : "warn", "Authenticode signature", "not checked outside Windows");
    }
  }

  const publishConfigured = Boolean(desktopPackage.build?.publish);
  add(publishConfigured ? "pass" : commercial ? "fail" : "warn", "automatic update publishing", publishConfigured ? "configured" : "not configured");
  return { commercial, results, version };
}

function labelFor(relativePath) {
  return relativePath.replaceAll("\\", "/");
}

function printReport(report) {
  console.log(`Forge ${report.version} release verification (${report.commercial ? "commercial" : "internal"})`);
  for (const result of report.results) console.log(`${result.level.toUpperCase().padEnd(4)}  ${result.label}: ${result.detail}`);
  const failures = report.results.filter((result) => result.level === "fail").length;
  const warnings = report.results.filter((result) => result.level === "warn").length;
  console.log(`Summary: ${failures} failure(s), ${warnings} warning(s)`);
  return failures;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const versionArgumentIndex = process.argv.indexOf("--version");
  const expectedVersion = versionArgumentIndex >= 0 ? process.argv[versionArgumentIndex + 1] : undefined;
  const report = verifyRelease({ expectedVersion, commercial: process.argv.includes("--commercial") });
  process.exitCode = printReport(report) ? 1 : 0;
}
