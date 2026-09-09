import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const codex = path.join(root, "release", "win-unpacked", "resources", "codex", "codex.exe");
const fixture = path.join(root, "tests", "fixtures", "sample-mcp-server.mjs");
const codexHome = await mkdtemp(path.join(os.tmpdir(), "forge-packaged-mcp-call-"));
const setting = (key, value) => ["-c", `${key}=${JSON.stringify(value)}`];
const child = spawn(codex, [
  "app-server", "--stdio",
  ...setting("mcp_servers.direct-sample.command", process.execPath),
  ...setting("mcp_servers.direct-sample.args", [fixture]),
  ...setting("mcp_servers.direct-sample.enabled", true),
  ...setting("mcp_servers.direct-sample.required", true),
  ...setting("mcp_servers.direct-sample.default_tools_approval_mode", "approve"),
], {
  env: { ...process.env, CODEX_HOME: codexHome },
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
});

let requestId = 0;
let stderr = "";
const pending = new Map();
child.stderr.on("data", (chunk) => { stderr += String(chunk); });
createInterface({ input: child.stdout }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined || message.method) return;
  const request = pending.get(message.id);
  if (!request) return;
  clearTimeout(request.timer);
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message || "App Server request failed"));
  else request.resolve(message.result);
});

function request(method, params, timeoutMs = 20_000) {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out.\n${stderr}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
  });
}

try {
  await request("initialize", { clientInfo: { name: "forge_release_test", title: "Forge release test", version: "0.2.0" } });
  child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
  const started = await request("thread/start", {
    cwd: root,
    approvalPolicy: "never",
    sandbox: "read-only",
    ephemeral: true,
  });
  const threadId = started?.thread?.id;
  assert.ok(threadId, "App Server did not return a thread id");
  const result = await request("mcpServer/tool/call", {
    threadId,
    server: "direct-sample",
    tool: "echo",
    arguments: { text: "FORGE_MCP_CALL_READY" },
  });
  assert.equal(result?.content?.[0]?.text, "FORGE_MCP_CALL_READY");
  assert.notEqual(result?.isError, true);
  console.log("Packaged MCP tool call: ready");
} finally {
  for (const request of pending.values()) clearTimeout(request.timer);
  pending.clear();
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(codexHome, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}
