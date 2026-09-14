import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskStore } from "../apps/daemon/dist/task-store.js";

const identity = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  mode: "cloud",
};

test("task backups are opaque, tenant-bound, non-overwriting, and restorable on another device", async () => {
  const previousDataDir = process.env.FORGE_DATA_DIR;
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "forge-backup-source-"));
  const targetDir = await mkdtemp(path.join(os.tmpdir(), "forge-backup-target-"));
  const wrongTenantDir = await mkdtemp(path.join(os.tmpdir(), "forge-backup-wrong-tenant-"));
  const passphrase = "正确的跨设备备份口令 2026";
  try {
    process.env.FORGE_DATA_DIR = sourceDir;
    const source = new TaskStore("C:\\private-source-workspace", identity);
    await source.load();
    const task = await source.create("需要跨设备恢复的任务");
    await source.addActivity(task.id, {
      id: "33333333-3333-4333-8333-333333333333",
      kind: "message",
      role: "user",
      text: "只有解密后才能看到的任务内容",
      contextFiles: [{ path: "C:\\private-source-workspace\\secret.ts", name: "secret.ts", size: 123 }],
      at: new Date().toISOString(),
    });
    await source.addActivity(task.id, {
      id: "77777777-7777-4777-8777-777777777777",
      kind: "files",
      turnId: "88888888-8888-4888-8888-888888888888",
      files: [{ path: "src/example.ts", additions: 1, deletions: 0, diff: "--- a/src/example.ts\n+++ b/src/example.ts\n@@ -0,0 +1 @@\n+export {};" }],
      at: new Date().toISOString(),
    });
    await source.addQueuedTurn(task.id, {
      id: "44444444-4444-4444-8444-444444444444",
      clientUserMessageId: "55555555-5555-4555-8555-555555555555",
      providerId: "deepseek",
      text: "不能在新设备自动执行",
      contextFiles: [],
      createdAt: new Date().toISOString(),
    });
    await source.setAgentSession(task.id, {
      providerId: "deepseek",
      model: "deepseek-chat",
      threadId: "remote-thread-id",
      cwd: "C:\\private-source-workspace",
      updatedAt: new Date().toISOString(),
    });

    const created = await source.createEncryptedBackup(passphrase);
    const serializedEnvelope = JSON.stringify(created.envelope);
    assert.equal(created.envelope.taskCount, 1);
    assert.ok(created.encryptedBytes > 0);
    assert.doesNotMatch(serializedEnvelope, /只有解密后|private-source-workspace|remote-thread-id/);

    process.env.FORGE_DATA_DIR = targetDir;
    const target = new TaskStore("D:\\new-device-workspace", identity);
    await target.load();
    await assert.rejects(target.restoreEncryptedBackup(created.envelope, "错误的备份口令 2026"), /口令错误/);
    const restored = await target.restoreEncryptedBackup(created.envelope, passphrase);
    assert.equal(restored.imported, 1);
    assert.equal(restored.skipped, 0);
    const restoredTask = restored.tasks[0];
    assert.equal(restoredTask.title, "需要跨设备恢复的任务");
    assert.equal(restoredTask.workspacePath, "D:\\new-device-workspace");
    assert.equal(restoredTask.queuedTurns.length, 0);
    assert.equal(restoredTask.agentSession, undefined);
    assert.ok(restoredTask.restoredFrom);
    const restoredMessage = restoredTask.activities.find((activity) => activity.kind === "message");
    assert.equal(restoredMessage.text, "只有解密后才能看到的任务内容");
    assert.equal(restoredMessage.contextFiles, undefined);
    const restoredFiles = restoredTask.activities.find((activity) => activity.kind === "files");
    assert.equal(restoredFiles.portableOnly, true);

    const repeated = await target.restoreEncryptedBackup(created.envelope, passphrase);
    assert.equal(repeated.imported, 0);
    assert.equal(repeated.skipped, 1);

    process.env.FORGE_DATA_DIR = wrongTenantDir;
    const wrongTenant = new TaskStore("E:\\wrong-tenant", { ...identity, tenantId: "66666666-6666-4666-8666-666666666666" });
    await wrongTenant.load();
    await assert.rejects(wrongTenant.restoreEncryptedBackup(created.envelope, passphrase), /租户不匹配/);
  } finally {
    if (previousDataDir === undefined) delete process.env.FORGE_DATA_DIR;
    else process.env.FORGE_DATA_DIR = previousDataDir;
    await rm(sourceDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
    await rm(wrongTenantDir, { recursive: true, force: true });
  }
});
