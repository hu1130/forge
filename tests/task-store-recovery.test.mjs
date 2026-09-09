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
