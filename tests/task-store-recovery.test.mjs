import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const taskStoreUrl = pathToFileURL(path.resolve("apps/daemon/dist/task-store.js")).href;

test("task store restores its backup and stops an interrupted task", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "forge-task-store-"));
  const previousDataDir = process.env.FORGE_DATA_DIR;
  process.env.FORGE_DATA_DIR = dataDir;

  try {
    const { TaskStore } = await import(`${taskStoreUrl}?recovery=${Date.now()}`);
    const store = new TaskStore("C:\\workspace");
    await store.load();
    const task = await store.create("恢复测试");
    await store.setState(task.id, "running");
    await store.update(task.id, { title: "运行中的任务" });

    await writeFile(path.join(dataDir, "state.json"), "{broken-json", "utf8");
    const recovered = new TaskStore("C:\\workspace");
    await recovered.load();

    const restoredTask = recovered.find(task.id);
    assert.ok(restoredTask, "the backup should preserve the task");
    assert.equal(restoredTask.state, "stopped");
    assert.match(restoredTask.activities.at(-1)?.kind === "notice" ? restoredTask.activities.at(-1).text : "", /意外中断/);

    const files = await readdir(dataDir);
    assert.ok(files.some((name) => name.startsWith("state.json.corrupt-")), "the broken primary file should be quarantined");
    const persisted = JSON.parse(await readFile(path.join(dataDir, "state.json"), "utf8"));
    assert.equal(persisted.tasks[0].state, "stopped");
  } finally {
    if (previousDataDir === undefined) delete process.env.FORGE_DATA_DIR;
    else process.env.FORGE_DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("task store serializes concurrent snapshots", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "forge-task-queue-"));
  const previousDataDir = process.env.FORGE_DATA_DIR;
  process.env.FORGE_DATA_DIR = dataDir;

  try {
    const { TaskStore } = await import(`${taskStoreUrl}?queue=${Date.now()}`);
    const store = new TaskStore("C:\\workspace");
    await store.load();
    await Promise.all(Array.from({ length: 12 }, (_, index) => store.create(`任务 ${index + 1}`)));
    const persisted = JSON.parse(await readFile(path.join(dataDir, "state.json"), "utf8"));
    assert.equal(persisted.tasks.length, 12);
  } finally {
    if (previousDataDir === undefined) delete process.env.FORGE_DATA_DIR;
    else process.env.FORGE_DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("task archive state survives a reload and can be restored", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "forge-task-archive-"));
  const previousDataDir = process.env.FORGE_DATA_DIR;
  process.env.FORGE_DATA_DIR = dataDir;

  try {
    const { TaskStore } = await import(`${taskStoreUrl}?archive=${Date.now()}`);
    const store = new TaskStore("C:\\workspace");
    await store.load();
    const task = await store.create("归档测试");
    await store.update(task.id, { archived: true });

    const reloaded = new TaskStore("C:\\workspace");
    await reloaded.load();
    assert.equal(reloaded.find(task.id)?.archived, true);
    await reloaded.update(task.id, { archived: false });
    assert.equal(reloaded.find(task.id)?.archived, false);
  } finally {
    if (previousDataDir === undefined) delete process.env.FORGE_DATA_DIR;
    else process.env.FORGE_DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("workspace preferences are validated, isolated, and survive reload", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "forge-task-preferences-"));
  const previousDataDir = process.env.FORGE_DATA_DIR;
  process.env.FORGE_DATA_DIR = dataDir;

  try {
    const { TaskStore } = await import(`${taskStoreUrl}?preferences=${Date.now()}`);
    const store = new TaskStore("C:\\workspace");
    await store.load();
    assert.deepEqual(store.preferences(), {
      defaultProviderId: "deepseek",
      approvalPolicy: "untrusted",
      rememberInspectorTab: true,
      defaultInspectorTab: "changes",
    });
    await store.updatePreferences({
      defaultProviderId: "demo",
      approvalPolicy: "on-request",
      rememberInspectorTab: false,
      defaultInspectorTab: "git",
    });

    const reloaded = new TaskStore("C:\\workspace");
    await reloaded.load();
    assert.equal(reloaded.preferences().approvalPolicy, "on-request");
    assert.equal(reloaded.preferences().defaultInspectorTab, "git");
    await assert.rejects(() => reloaded.updatePreferences({ approvalPolicy: "never" }), /偏好设置无效/);
    await assert.rejects(() => reloaded.updatePreferences({ hiddenOption: true }), /未知字段/);
  } finally {
    if (previousDataDir === undefined) delete process.env.FORGE_DATA_DIR;
    else process.env.FORGE_DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("queued turns persist, reorder, and survive an interrupted daemon restart", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "forge-task-turn-queue-"));
  const previousDataDir = process.env.FORGE_DATA_DIR;
  process.env.FORGE_DATA_DIR = dataDir;

  try {
    const { TaskStore } = await import(`${taskStoreUrl}?turn-queue=${Date.now()}`);
    const store = new TaskStore("C:\\workspace");
    await store.load();
    const task = await store.create("队列恢复测试");
    await store.setState(task.id, "running");
    const first = { id: "queue-1", clientUserMessageId: "message-1", providerId: "demo", text: "第一条", contextFiles: [], createdAt: new Date().toISOString() };
    const second = { id: "queue-2", clientUserMessageId: "message-2", providerId: "demo", text: "第二条", contextFiles: [], createdAt: new Date().toISOString() };
    await store.addQueuedTurn(task.id, first);
    await store.addQueuedTurn(task.id, second);
    await store.reorderQueuedTurns(task.id, [second.id, first.id]);

    const reloaded = new TaskStore("C:\\workspace");
    await reloaded.load();
    assert.equal(reloaded.find(task.id)?.state, "stopped");
    assert.deepEqual(reloaded.find(task.id)?.queuedTurns?.map((item) => item.id), [second.id, first.id]);

    await reloaded.removeQueuedTurn(task.id, second.id);
    assert.deepEqual(reloaded.find(task.id)?.queuedTurns?.map((item) => item.id), [first.id]);
    await assert.rejects(() => reloaded.reorderQueuedTurns(task.id, ["unknown"]), /队列顺序与当前任务不一致/);
  } finally {
    if (previousDataDir === undefined) delete process.env.FORGE_DATA_DIR;
    else process.env.FORGE_DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
});
