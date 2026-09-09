import { execFileSync } from "node:child_process";
import { copyFile, cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopRoot = path.join(projectRoot, "apps", "desktop");
const targetRoot = path.join(desktopRoot, ".bundle", "codex");
const daemonTargetRoot = path.join(desktopRoot, ".bundle", "daemon");
const optionalHelpers = ["codex-code-mode-host.exe", "codex-command-runner.exe", "codex-windows-sandbox-setup.exe"];
const supportedCodexVersion = "0.153.4";

function findCodexDirectory() {
  const configured = process.env.FORGE_CODEX_SOURCE_DIR?.trim();
  if (configured) return path.resolve(configured);
  const located = execFileSync("where.exe", ["codex.exe"], { encoding: "utf8", windowsHide: true })
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  if (!located) throw new Error("没有找到 codex.exe。请先安装官方 Codex CLI，或设置 FORGE_CODEX_SOURCE_DIR。");
  return path.dirname(located);
}

const sourceRoot = findCodexDirectory();
const sourceExecutable = path.join(sourceRoot, "codex.exe");
const version = execFileSync(sourceExecutable, ["--version"], { encoding: "utf8", windowsHide: true }).trim();
if (!/^codex-cli\s+/i.test(version)) throw new Error(`无法确认 Codex CLI 版本：${version || "无输出"}`);
if (version !== `codex-cli ${supportedCodexVersion}`) {
  throw new Error(`Codex CLI 版本不兼容：需要 ${supportedCodexVersion}，实际为 ${version}`);
}

await rm(targetRoot, { recursive: true, force: true });
await mkdir(targetRoot, { recursive: true });
await copyFile(sourceExecutable, path.join(targetRoot, "codex.exe"));

for (const helper of optionalHelpers) {
  try {
    await copyFile(path.join(sourceRoot, helper), path.join(targetRoot, helper));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
    throw error;
  }
}

const notice = await readFile(path.join(desktopRoot, "third-party", "THIRD_PARTY_NOTICES.md"), "utf8");
await writeFile(path.join(targetRoot, "VERSION.txt"), `${version}\n\n${notice}`, "utf8");

await rm(daemonTargetRoot, { recursive: true, force: true });
await build({
  entryPoints: [path.join(projectRoot, "apps", "daemon", "src", "server.ts")],
  outfile: path.join(daemonTargetRoot, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["node-pty"],
  banner: { js: 'import { createRequire as __forgeCreateRequire } from "node:module"; const require = __forgeCreateRequire(import.meta.url);' },
  legalComments: "linked",
});
await cp(
  path.join(projectRoot, "apps", "daemon", "resources"),
  path.join(daemonTargetRoot, "resources"),
  { recursive: true },
);
const nodePtySource = await realpath(path.join(projectRoot, "apps", "daemon", "node_modules", "node-pty"));
await cp(nodePtySource, path.join(daemonTargetRoot, "node_modules", "node-pty"), { recursive: true });
console.log(`Prepared ${version} and bundled Forge Daemon`);
