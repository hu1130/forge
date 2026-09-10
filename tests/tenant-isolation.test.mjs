import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ExtensionStore } from "../apps/daemon/dist/extension-store.js";
import { TaskStore, tenantStorageKey } from "../apps/daemon/dist/task-store.js";

const tenantA = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  mode: "cloud",
};
const tenantB = {
  tenantId: "22222222-2222-4222-8222-222222222222",
  userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  mode: "cloud",
};

test("tasks, Skills, and MCP configs are physically isolated by tenant", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "forge-tenants-"));
  const previousDataDir = process.env.FORGE_DATA_DIR;
  process.env.FORGE_DATA_DIR = dataDir;
  try {
    const tasksA = new TaskStore("C:\\workspace-a", tenantA);
    const extensionsA = new ExtensionStore(tenantA);
    await tasksA.load();
    await extensionsA.load();
    const taskA = await tasksA.create("租户 A 的任务");
    await extensionsA.importSkill(path.resolve("tests/fixtures/sample-skill"), "global", "C:\\workspace-a");
    await extensionsA.addMcpServer({ name: "tenant-a-mcp", transport: "stdio", command: "node" });

    const tasksB = new TaskStore("C:\\workspace-b", tenantB);
    const extensionsB = new ExtensionStore(tenantB);
    await tasksB.load();
    await extensionsB.load();
    assert.deepEqual(tasksB.list(), []);
    assert.deepEqual(extensionsB.listSkills("C:\\workspace-b"), []);
    assert.deepEqual(extensionsB.listMcpServers(), []);
    const taskB = await tasksB.create("租户 B 的任务");

    const reloadedTasksA = new TaskStore("C:\\ignored", tenantA);
    const reloadedExtensionsA = new ExtensionStore(tenantA);
    await reloadedTasksA.load();
    await reloadedExtensionsA.load();
    assert.deepEqual(reloadedTasksA.list().map((task) => task.id), [taskA.id]);
    assert.equal(reloadedTasksA.list()[0].tenantId, tenantA.tenantId);
    assert.equal(reloadedTasksA.list()[0].userId, tenantA.userId);
    assert.equal(reloadedExtensionsA.listSkills("C:\\workspace-a")[0].tenantId, tenantA.tenantId);
    assert.equal(reloadedExtensionsA.listMcpServers()[0].tenantId, tenantA.tenantId);
    assert.notEqual(taskA.id, taskB.id);

    const stateAPath = path.join(dataDir, "tenants", tenantStorageKey(tenantA.tenantId), "state.json");
    const stateBPath = path.join(dataDir, "tenants", tenantStorageKey(tenantB.tenantId), "state.json");
    const persistedA = JSON.parse(await readFile(stateAPath, "utf8"));
    const persistedB = JSON.parse(await readFile(stateBPath, "utf8"));
    assert.equal(persistedA.tenantId, tenantA.tenantId);
    assert.equal(persistedB.tenantId, tenantB.tenantId);
    assert.equal(persistedA.tasks[0].title, "租户 A 的任务");
    assert.equal(persistedB.tasks[0].title, "租户 B 的任务");
  } finally {
    if (previousDataDir === undefined) delete process.env.FORGE_DATA_DIR;
    else process.env.FORGE_DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("the unauthenticated local profile keeps its legacy storage location", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "forge-local-profile-"));
  const previousDataDir = process.env.FORGE_DATA_DIR;
  process.env.FORGE_DATA_DIR = dataDir;
  try {
    const store = new TaskStore("C:\\local-workspace");
    await store.load();
    const task = await store.create("本地任务");
    const persisted = JSON.parse(await readFile(path.join(dataDir, "state.json"), "utf8"));
    assert.equal(task.tenantId, "local");
    assert.equal(persisted.tasks[0].title, "本地任务");
  } finally {
    if (previousDataDir === undefined) delete process.env.FORGE_DATA_DIR;
    else process.env.FORGE_DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("desktop resolves cloud identity server-side before switching daemon storage", async () => {
  const desktop = await readFile("apps/desktop/main.cjs", "utf8");
  const preload = await readFile("apps/desktop/preload.cjs", "utf8");
  const gate = await readFile("apps/web/src/CloudAuthGate.tsx", "utf8");
  const webApp = await readFile("apps/web/src/App.tsx", "utf8");
  assert.match(desktop, /fetch\(`\$\{cloudApiUrl\}\/v1\/auth\/session`/);
  assert.match(desktop, /FORGE_TENANT_ID: activeIdentity\.mode === "cloud"/);
  assert.match(desktop, /FORGE_USER_ID: activeIdentity\.mode === "cloud"/);
  assert.match(desktop, /mcpTokensByTenant/);
  assert.match(preload, /activateCloudContext: \(\) => ipcRenderer\.invoke\("forge:activate-cloud-context"\)/);
  assert.doesNotMatch(preload, /activateCloudContext: \([^)]*[A-Za-z]/);
  assert.match(gate, /activateDesktopTenant/);
  assert.match(webApp, /payload\.identity\.tenantId !== cloudSession\.tenant\.id/);
  assert.doesNotMatch(webApp, /window\.forgeDesktop && cloudSession && \(payload\.identity/);
});
