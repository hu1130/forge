import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("extension catalog sync includes only safe marketplace metadata and uses conflict receipts", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "forge-extension-sync-"));
  const previousDataDir = process.env.FORGE_DATA_DIR;
  process.env.FORGE_DATA_DIR = dataDir;
  try {
    const extensions = new ExtensionStore(tenantA);
    await extensions.load();
    await extensions.importSkill(path.resolve("tests/fixtures/sample-skill"), "global", "C:\\workspace-a");
    await extensions.addMcpServer({ name: "private-http", transport: "http", url: "https://private.example/mcp", useBearerToken: true });
    const marketSkill = await extensions.installMarketSkill(
      path.resolve("apps/daemon/resources/marketplace/skills/forge-code-review"),
      "global",
      "C:\\workspace-a",
      "forge-code-review",
      "1.0.0",
    );
    await extensions.installMarketMcp({
      name: "filesystem",
      transport: "stdio",
      command: "cmd",
      args: ["/c", "npx", "C:\\private-workspace"],
      envVars: ["SECRET_TOKEN"],
      approvalMode: "writes",
      marketplaceId: "mcp-filesystem",
      marketplaceVersion: "1.0.0",
    });

    const snapshot = extensions.extensionSyncSnapshot("C:\\workspace-a");
    assert.equal(snapshot.entries.length, 2);
    assert.deepEqual(snapshot.excluded, { customSkills: 1, customMcpServers: 1 });
    const serialized = JSON.stringify(snapshot.entries);
    assert.doesNotMatch(serialized, /private-workspace|private\.example|SECRET_TOKEN/);
    assert.doesNotMatch(serialized, /"(?:sourcePath|workspacePath|command|args|envVars|url|tokenConfigured|useBearerToken)"/);

    const skillEntry = snapshot.entries.find((entry) => entry.kind === "skill");
    assert.ok(skillEntry);
    assert.deepEqual(Object.keys(skillEntry.metadata).sort(), ["enabled", "marketplaceId", "marketplaceVersion", "scope", "updatedAt"]);
    await extensions.recordExtensionSync("skill", skillEntry.key, {
      resourceVersion: 1,
      localUpdatedAt: skillEntry.metadata.updatedAt,
    }, "C:\\workspace-a");

    await new Promise((resolve) => setTimeout(resolve, 2));
    await extensions.setSkillEnabled(marketSkill.id, false);
    await assert.rejects(
      extensions.recordExtensionSync("skill", skillEntry.key, {
        resourceVersion: 2,
        localUpdatedAt: skillEntry.metadata.updatedAt,
      }, "C:\\workspace-a"),
      /扩展已发生变化/,
    );

    const changed = extensions.extensionSyncSnapshot("C:\\workspace-a").entries.find((entry) => entry.kind === "skill");
    assert.ok(changed && "scope" in changed.metadata);
    const remoteUpdatedAt = new Date(Date.now() + 1_000).toISOString();
    const applied = await extensions.applyCloudExtensionMetadata("skill", skillEntry.key, {
      ...changed.metadata,
      enabled: true,
      updatedAt: remoteUpdatedAt,
    }, changed.metadata.updatedAt, 2, "C:\\workspace-a");
    const appliedSkill = applied.entries.find((entry) => entry.kind === "skill");
    assert.equal(appliedSkill.metadata.enabled, true);
    assert.deepEqual(applied.receipts[`skill:${skillEntry.key}`], { resourceVersion: 2, localUpdatedAt: remoteUpdatedAt });
    await extensions.restoreExtensionSyncState("skill", skillEntry.key, changed.metadata, {
      resourceVersion: 1,
      localUpdatedAt: skillEntry.metadata.updatedAt,
    }, "C:\\workspace-a");
    const restored = extensions.extensionSyncSnapshot("C:\\workspace-a");
    assert.equal(restored.entries.find((entry) => entry.kind === "skill").metadata.enabled, false);
    assert.equal(restored.receipts[`skill:${skillEntry.key}`].resourceVersion, 1);

    const extensionStatePath = path.join(dataDir, "tenants", tenantStorageKey(tenantA.tenantId), "extensions.json");
    const legacyState = JSON.parse(await readFile(extensionStatePath, "utf8"));
    legacyState.schemaVersion = 2;
    delete legacyState.extensionSyncReceipts;
    for (const skill of legacyState.skills) delete skill.updatedAt;
    for (const server of legacyState.mcpServers) delete server.updatedAt;
    await writeFile(extensionStatePath, `${JSON.stringify(legacyState, null, 2)}\n`, "utf8");

    const migratedStore = new ExtensionStore(tenantA);
    await migratedStore.load();
    const migratedState = JSON.parse(await readFile(extensionStatePath, "utf8"));
    assert.equal(migratedState.schemaVersion, 3);
    assert.deepEqual(migratedState.extensionSyncReceipts, {});
    assert.equal(migratedState.skills.every((skill) => skill.updatedAt === skill.installedAt), true);
    assert.equal(migratedState.mcpServers.every((server) => server.updatedAt === server.createdAt), true);
  } finally {
    if (previousDataDir === undefined) delete process.env.FORGE_DATA_DIR;
    else process.env.FORGE_DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a cloud tenant imports local tasks once and tracks conflict-safe sync receipts", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "forge-local-import-"));
  const previousDataDir = process.env.FORGE_DATA_DIR;
  process.env.FORGE_DATA_DIR = dataDir;
  try {
    const local = new TaskStore("C:\\local-workspace");
    await local.load();
    const source = await local.create("需要导入的任务");
    await local.addActivity(source.id, { id: "message-1", kind: "message", role: "user", text: "保留这段本机对话", at: new Date().toISOString() });
    await local.addQueuedTurn(source.id, { id: "queue-1", clientUserMessageId: "message-2", providerId: "demo", text: "不要迁移等待队列", contextFiles: [], createdAt: new Date().toISOString() });
    await local.setAgentSession(source.id, { providerId: "demo", model: "demo", threadId: "thread-1", cwd: "C:\\local-workspace", updatedAt: new Date().toISOString() });

    const tenant = new TaskStore("C:\\tenant-workspace", tenantA);
    await tenant.load();
    assert.deepEqual(await tenant.localProfileSummary(), { available: true, totalTasks: 1, eligibleTasks: 1, alreadyImported: 0 });
    const firstImport = await tenant.importLocalProfile();
    assert.equal(firstImport.imported, 1);
    assert.notEqual(firstImport.tasks[0].id, source.id);
    assert.equal(firstImport.tasks[0].importedFrom.taskId, source.id);
    assert.equal(firstImport.tasks[0].activities.some((activity) => activity.kind === "message" && activity.text === "保留这段本机对话"), true);
    assert.deepEqual(firstImport.tasks[0].queuedTurns, []);
    assert.equal(firstImport.tasks[0].agentSession, undefined);
    const secondImport = await tenant.importLocalProfile();
    assert.equal(secondImport.imported, 0);
    assert.equal(secondImport.summary.alreadyImported, 1);

    const imported = tenant.list()[0];
    await tenant.recordTaskSync(imported.id, { resourceVersion: 1, taskUpdatedAt: imported.updatedAt });
    const baseline = tenant.taskSyncSnapshot().receipts[imported.id];
    assert.equal(baseline.resourceVersion, 1);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await tenant.update(imported.id, { title: "本机已经修改" });
    const changed = tenant.find(imported.id);
    await assert.rejects(
      tenant.recordTaskSync(imported.id, { resourceVersion: 2, taskUpdatedAt: baseline.taskUpdatedAt }),
      /任务已发生变化/,
    );
    const cloudUpdatedAt = new Date(Date.now() + 1_000).toISOString();
    const applied = await tenant.applyCloudTaskMetadata(imported.id, {
      title: "采用云端名称", pinned: true, archived: false, updatedAt: cloudUpdatedAt,
    }, changed.updatedAt, 2);
    assert.equal(applied.title, "采用云端名称");
    assert.equal(tenant.taskSyncSnapshot().receipts[imported.id].resourceVersion, 2);
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
