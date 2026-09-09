import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const unpacked = path.join(root, "release", "win-unpacked");
const dataDir = await mkdtemp(path.join(os.tmpdir(), "forge-packaged-extensions-"));
const port = 4785;
const baseUrl = `http://127.0.0.1:${port}`;
let stdout = "";
let stderr = "";

const child = spawn(path.join(unpacked, "Forge.exe"), [path.join(unpacked, "resources", "daemon", "server.mjs")], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    FORGE_PORT: String(port),
    FORGE_DATA_DIR: dataDir,
    FORGE_CODEX_HOME: path.join(dataDir, "codex"),
    FORGE_WEB_ROOT: path.join(unpacked, "resources", "web"),
    FORGE_WORKSPACE: root,
    FORGE_CODEX_BIN: path.join(unpacked, "resources", "codex", "codex.exe"),
    DEEPSEEK_API_KEY: "",
  },
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => { stdout += String(chunk); });
child.stderr.on("data", (chunk) => { stderr += String(chunk); });

async function request(url, options) {
  const response = await fetch(`${baseUrl}${url}`, options);
  const payload = await response.json().catch(() => ({}));
  assert.ok(response.ok, `${url} failed: ${JSON.stringify(payload)}`);
  return payload;
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const health = await fetch(`${baseUrl}/api/health`);
      if (health.ok) { ready = true; break; }
    } catch {
      // The packaged daemon is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(ready, `Packaged daemon failed to start.\n${stdout}\n${stderr}`);

  const market = await request("/api/marketplace?scope=project");
  assert.equal(market.source.kind, "builtIn");
  assert.ok(market.items.some((item) => item.id === "forge-code-review"));
  const installedMarket = await request("/api/marketplace/items/forge-code-review/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "project" }),
  });
  assert.equal(installedMarket.items.find((item) => item.id === "forge-code-review")?.installation.status, "installed");
  const removedMarket = await request("/api/marketplace/items/forge-code-review", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "project" }),
  });
  assert.equal(removedMarket.items.find((item) => item.id === "forge-code-review")?.installation.status, "notInstalled");

  await request("/api/skills/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourcePath: path.join(root, "tests", "fixtures", "sample-skill"), scope: "project" }),
  });
  await request("/api/mcp/servers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "packaged-sample",
      transport: "stdio",
      command: process.execPath,
      args: [path.join(root, "tests", "fixtures", "sample-mcp-server.mjs")],
      approvalMode: "writes",
    }),
  });
  const extensions = await request("/api/extensions");
  assert.equal(extensions.skills.find((skill) => skill.name === "forge-sample")?.status, "ready");
  const server = extensions.mcpServers.find((entry) => entry.name === "packaged-sample");
  assert.equal(server?.status, "connected");
  assert.ok(server?.tools.some((tool) => tool.name === "echo"));
  console.log("Packaged Marketplace + Skills + MCP integration: ready");
} finally {
  if (child.exitCode === null) {
    child.kill();
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(dataDir, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}
