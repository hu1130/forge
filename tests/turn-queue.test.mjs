import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(baseUrl, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // Daemon is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("test daemon did not start");
}

async function jsonRequest(baseUrl, route, options) {
  const response = await fetch(`${baseUrl}${route}`, options);
  const payload = await response.json().catch(() => ({}));
  assert.ok(response.ok, `${route} failed: ${JSON.stringify(payload)}`);
  return payload;
}

test("demo turns accept steer input and execute a persistent, reorderable queue", { timeout: 20_000 }, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "forge-turn-queue-api-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let stdout = "";
  let stderr = "";
  const child = spawn(process.execPath, [path.resolve("apps/daemon/dist/server.js")], {
    env: {
      ...process.env,
      FORGE_PORT: String(port),
      FORGE_DATA_DIR: dataDir,
      FORGE_WORKSPACE: process.cwd(),
      FORGE_SKIP_RUNTIME_PREWARM: "1",
      DEEPSEEK_API_KEY: "",
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });

  try {
    await waitForHealth(baseUrl, child);
    const task = await jsonRequest(baseUrl, "/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "队列联调" }),
    });
    const stream = await fetch(`${baseUrl}/api/tasks/${task.id}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "第一轮", providerId: "demo" }),
    });
    assert.ok(stream.ok);

    const steer = await jsonRequest(baseUrl, `/api/tasks/${task.id}/steer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "先检查测试" }),
    });
    assert.equal(steer.activity.delivery, "steer");

    const queuedFirst = await jsonRequest(baseUrl, `/api/tasks/${task.id}/queue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "第二轮" }),
    });
    const firstId = queuedFirst.items[0].id;
    const queuedSecond = await jsonRequest(baseUrl, `/api/tasks/${task.id}/queue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "第三轮" }),
    });
    const secondId = queuedSecond.items[1].id;
    const queuedCancelled = await jsonRequest(baseUrl, `/api/tasks/${task.id}/queue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "不要执行" }),
    });
    const cancelledId = queuedCancelled.items[2].id;
    await jsonRequest(baseUrl, `/api/tasks/${task.id}/queue/${cancelledId}`, { method: "DELETE" });
    await jsonRequest(baseUrl, `/api/tasks/${task.id}/queue/reorder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queuedTurnIds: [secondId, firstId] }),
    });

    const events = await stream.text();
    assert.equal((events.match(/"state":"started"/g) || []).length, 3);
    const completed = await jsonRequest(baseUrl, `/api/tasks/${task.id}`);
    assert.equal(completed.state, "completed");
    assert.deepEqual(completed.queuedTurns, []);
    const userMessages = completed.activities.filter((activity) => activity.kind === "message" && activity.role === "user");
    assert.deepEqual(userMessages.map((activity) => activity.text), ["第一轮", "先检查测试", "第三轮", "第二轮"]);
    assert.equal(userMessages[1].delivery, "steer");
    assert.ok(!completed.activities.some((activity) => activity.kind === "message" && activity.text === "不要执行"));

    const stoppedTask = await jsonRequest(baseUrl, "/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "停止后继续队列" }),
    });
    const stoppedStream = await fetch(`${baseUrl}/api/tasks/${stoppedTask.id}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "会被停止的第一轮", providerId: "demo" }),
    });
    assert.ok(stoppedStream.ok);
    await jsonRequest(baseUrl, `/api/tasks/${stoppedTask.id}/queue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "停止后仍要执行" }),
    });
    await jsonRequest(baseUrl, `/api/tasks/${stoppedTask.id}/stop`, { method: "POST" });
    await stoppedStream.text();

    const stopped = await jsonRequest(baseUrl, `/api/tasks/${stoppedTask.id}`);
    assert.equal(stopped.state, "stopped");
    assert.deepEqual(stopped.queuedTurns.map((item) => item.text), ["停止后仍要执行"]);

    const resumedStream = await fetch(`${baseUrl}/api/tasks/${stoppedTask.id}/queue/start`, { method: "POST" });
    assert.ok(resumedStream.ok);
    await resumedStream.text();
    const resumed = await jsonRequest(baseUrl, `/api/tasks/${stoppedTask.id}`);
    assert.equal(resumed.state, "completed");
    assert.deepEqual(resumed.queuedTurns, []);
    const resumedMessages = resumed.activities.filter((activity) => activity.kind === "message" && activity.role === "user");
    assert.deepEqual(resumedMessages.map((activity) => activity.text), ["会被停止的第一轮", "停止后仍要执行"]);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stdout}\n${stderr}`.trim());
  } finally {
    if (child.exitCode === null) child.kill();
    await new Promise((resolve) => child.exitCode !== null ? resolve() : child.once("exit", resolve));
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await rm(dataDir, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 7) throw error;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  }
});

test("v0.10 UI exposes explicit steer and queue controls", async () => {
  const { readFile } = await import("node:fs/promises");
  const bridge = await readFile("apps/daemon/src/codex-bridge.ts", "utf8");
  const server = await readFile("apps/daemon/src/server.ts", "utf8");
  const app = await readFile("apps/web/src/App.tsx", "utf8");
  const queue = await readFile("apps/web/src/TurnQueue.tsx", "utf8");
  assert.match(bridge, /experimentalApi: true/);
  for (const method of ["turn/steer", "thread/queue/add", "thread/queue/delete", "thread/queue/reorder", "thread/queue/start"]) assert.ok(server.includes(method));
  assert.match(app, /补充当前任务/);
  assert.match(app, /排到下一轮/);
  assert.match(queue, /继续执行/);
  assert.match(queue, /取消等待/);
});
