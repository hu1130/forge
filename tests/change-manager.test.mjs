import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const changeManagerUrl = pathToFileURL(path.resolve("apps/daemon/dist/change-manager.js")).href;
const patch = `diff --git a/example.txt b/example.txt
--- a/example.txt
+++ b/example.txt
@@ -1 +1 @@
-before
+after`;

test("task changes are checked, reverted, and reapplied without a Git repository", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "forge-changes-"));
  try {
    const { applyTaskChanges } = await import(`${changeManagerUrl}?roundtrip=${Date.now()}`);
    const activity = { id: "files-1", kind: "files", files: [{ path: "example.txt", additions: 1, deletions: 1, diff: patch }], at: new Date().toISOString() };
    const task = { id: "task-1", tenantId: "local", userId: "local", title: "change test", subtitle: "", workspacePath: workspace, state: "completed", activities: [activity], updatedAt: new Date().toISOString() };
    await writeFile(path.join(workspace, "example.txt"), "after\n", "utf8");

    assert.deepEqual(await applyTaskChanges(task, "revert"), [activity.id]);
    assert.equal(await readFile(path.join(workspace, "example.txt"), "utf8"), "before\n");
    activity.revertedAt = new Date().toISOString();
    assert.deepEqual(await applyTaskChanges(task, "reapply"), [activity.id]);
    assert.equal(await readFile(path.join(workspace, "example.txt"), "utf8"), "after\n");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("task change revert refuses to overwrite later user edits", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "forge-change-conflict-"));
  try {
    const { applyTaskChanges } = await import(`${changeManagerUrl}?conflict=${Date.now()}`);
    const task = {
      id: "task-2",
      tenantId: "local",
      userId: "local",
      title: "conflict test",
      subtitle: "",
      workspacePath: workspace,
      state: "completed",
      activities: [{ id: "files-2", kind: "files", files: [{ path: "example.txt", additions: 1, deletions: 1, diff: patch }], at: new Date().toISOString() }],
      updatedAt: new Date().toISOString(),
    };
    await writeFile(path.join(workspace, "example.txt"), "user changed this later\n", "utf8");

    await assert.rejects(() => applyTaskChanges(task, "revert"), /文件内容可能已被继续修改/);
    assert.equal(await readFile(path.join(workspace, "example.txt"), "utf8"), "user changed this later\n");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a middle turn can be reverted without removing later independent changes", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "forge-turn-checkpoint-"));
  try {
    const { applyTaskChanges } = await import(`${changeManagerUrl}?turn=${Date.now()}`);
    const firstPatch = patch.replaceAll("example.txt", "first.txt");
    const secondPatch = patch.replaceAll("example.txt", "second.txt");
    const activities = [
      { id: "turn-diff-1", kind: "files", turnId: "turn-1", files: [{ path: "first.txt", additions: 1, deletions: 1, diff: firstPatch }], at: new Date().toISOString() },
      { id: "turn-diff-2", kind: "files", turnId: "turn-2", files: [{ path: "second.txt", additions: 1, deletions: 1, diff: secondPatch }], at: new Date().toISOString() },
    ];
    const task = { id: "task-3", tenantId: "local", userId: "local", title: "turn test", subtitle: "", workspacePath: workspace, state: "completed", activities, updatedAt: new Date().toISOString() };
    await writeFile(path.join(workspace, "first.txt"), "after\n", "utf8");
    await writeFile(path.join(workspace, "second.txt"), "after\n", "utf8");

    assert.deepEqual(await applyTaskChanges(task, "revert", "turn-1"), ["turn-diff-1"]);
    assert.equal(await readFile(path.join(workspace, "first.txt"), "utf8"), "before\n");
    assert.equal(await readFile(path.join(workspace, "second.txt"), "utf8"), "after\n");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
