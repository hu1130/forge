import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { deepSeekAppServerArgs } from "../../apps/daemon/dist/deepseek.js";

const codexHome = await mkdtemp(path.join(os.tmpdir(), "forge-native-queue-probe-"));
const modelServer = createServer(() => {
  // Keep the first model request in flight so subsequent submissions remain queued.
});
await new Promise((resolve, reject) => modelServer.listen(0, "127.0.0.1", resolve).once("error", reject));
const modelAddress = modelServer.address();
const modelPort = typeof modelAddress === "object" && modelAddress ? modelAddress.port : 0;
const executable = process.env.FORGE_CODEX_BIN || "codex";
const child = spawn(executable, [
  "app-server", "--stdio",
  ...deepSeekAppServerArgs({ configured: true, baseUrl: `http://127.0.0.1:${modelPort}/`, model: "deepseek-v4-flash" }),
], {
  env: { ...process.env, CODEX_HOME: codexHome, DEEPSEEK_API_KEY: "forge-protocol-probe" },
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
});

let requestId = 0;
let stderr = "";
const pending = new Map();
const notifications = [];
child.stderr.on("data", (chunk) => { stderr += String(chunk); });
createInterface({ input: child.stdout }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method && message.id === undefined) {
    notifications.push(message);
    return;
  }
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
      reject(new Error(`${method} timed out\n${stderr}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
  });
}

async function waitForNotification(method, predicate = () => true) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const found = notifications.find((message) => message.method === method && predicate(message.params));
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${method} notification timed out\n${stderr}`);
}

try {
  await request("initialize", {
    clientInfo: { name: "forge_queue_probe", title: "Forge Queue Probe", version: "0.10.0" },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
  const started = await request("thread/start", {
    model: "deepseek-v4-flash",
    modelProvider: "deepseek",
    allowProviderModelFallback: false,
    cwd: process.cwd(),
    approvalPolicy: "untrusted",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
    ephemeral: false,
  });
  const threadId = started?.thread?.id;
  assert.ok(threadId, "thread/start did not return a thread id");
  const first = await request("thread/queue/add", {
    threadId,
    input: [{ type: "text", text: "first", text_elements: [] }],
    clientUserMessageId: "probe-message-1",
  });
  const second = await request("thread/queue/add", {
    threadId,
    input: [{ type: "text", text: "second", text_elements: [] }],
    clientUserMessageId: "probe-message-2",
  });
  const third = await request("thread/queue/add", {
    threadId,
    input: [{ type: "text", text: "third", text_elements: [] }],
    clientUserMessageId: "probe-message-3",
  });
  const firstId = first?.queuedSubmission?.id;
  const secondId = second?.queuedSubmission?.id;
  const thirdId = third?.queuedSubmission?.id;
  assert.ok(firstId && secondId && thirdId, "thread/queue/add did not return queue ids");
  const beforeReorder = await request("thread/queue/list", { threadId, limit: 20 });
  assert.ok(beforeReorder?.data?.some((item) => item.id === secondId));
  assert.ok(beforeReorder?.data?.some((item) => item.id === thirdId));
  assert.ok(!beforeReorder?.data?.some((item) => item.id === firstId), "the idle first submission should have started immediately");
  const reversedIds = beforeReorder.data.map((item) => item.id).reverse();
  await request("thread/queue/reorder", { threadId, queuedSubmissionIds: reversedIds });
  const reordered = await request("thread/queue/list", { threadId, limit: 20 });
  assert.deepEqual(reordered?.data?.map((item) => item.id), reversedIds);
  await request("thread/queue/delete", { threadId, queuedSubmissionId: thirdId });
  const remaining = await request("thread/queue/list", { threadId, limit: 20 });
  assert.deepEqual(remaining?.data?.map((item) => item.id), [secondId]);

  const firstStarted = await waitForNotification("turn/started", (params) => params?.threadId === threadId);
  const firstTurnId = firstStarted.params?.turn?.id;
  assert.ok(firstTurnId, "the first queued submission did not start a turn");
  await request("turn/interrupt", { threadId, turnId: firstTurnId });
  await waitForNotification("turn/completed", (params) => params?.turn?.id === firstTurnId);
  const queuedStart = await request("thread/queue/start", { threadId, queuedSubmissionId: secondId });
  const queuedTurnId = queuedStart?.turn?.id;
  assert.ok(queuedTurnId, "thread/queue/start did not return a turn");
  process.stdout.write("Native App Server steer/queue protocol: ready\n");
} finally {
  for (const item of pending.values()) clearTimeout(item.timer);
  pending.clear();
  child.kill();
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  modelServer.closeAllConnections();
  await new Promise((resolve) => modelServer.close(resolve));
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(codexHome, { recursive: true, force: true });
      break;
    } catch (error) {
      if (attempt === 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}
