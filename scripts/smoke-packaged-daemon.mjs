import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const unpacked = path.join(root, "release", "win-unpacked");
const port = "4784";
let output = "";
let errorOutput = "";
const child = spawn(path.join(unpacked, "Forge.exe"), [path.join(unpacked, "resources", "daemon", "server.mjs")], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    FORGE_PORT: port,
    FORGE_DATA_DIR: path.join(os.tmpdir(), "forge-packaged-daemon-smoke"),
    FORGE_WEB_ROOT: path.join(unpacked, "resources", "web"),
    FORGE_WORKSPACE: root,
    FORGE_CODEX_BIN: path.join(unpacked, "resources", "codex", "codex.exe"),
    DEEPSEEK_API_KEY: "",
  },
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => { output += String(chunk); });
child.stderr.on("data", (chunk) => { errorOutput += String(chunk); });

let ready = false;
let gitReady = false;
let contextFilesReady = false;
try {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) {
        const health = await response.json();
        if (health.daemon === "ready") {
          ready = true;
          const bootstrap = await fetch(`http://127.0.0.1:${port}/api/bootstrap`).then((result) => result.json());
          gitReady = typeof bootstrap.git?.isRepository === "boolean"
            && Array.isArray(bootstrap.git?.changes)
            && Array.isArray(bootstrap.git?.branches)
            && Array.isArray(bootstrap.git?.commits);
          const filesResponse = await fetch(`http://127.0.0.1:${port}/api/workspace/files?query=workspace-files`);
          const files = await filesResponse.json();
          contextFilesReady = filesResponse.ok
            && files.files?.some((file) => file.path === "apps/daemon/src/workspace-files.ts")
            && !files.files?.some((file) => file.path.includes("node_modules"));
        }
        break;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
} finally {
  child.kill();
}

if (!ready) {
  throw new Error(`Packaged daemon did not become ready.\n${output}\n${errorOutput}`.trim());
}
if (!gitReady) throw new Error("Packaged daemon did not expose real Git status in bootstrap");
if (!contextFilesReady) throw new Error("Packaged daemon did not expose safe workspace file search");
console.log("Packaged daemon smoke: ready");
