import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const run = promisify(execFile);
const moduleUrl = pathToFileURL(path.resolve("apps/daemon/dist/git-manager.js")).href;

test("Git status, branch creation, and staged-only commits use the real workspace", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "forge-git-"));
  try {
    await run("git", ["init"], { cwd: workspace });
    await run("git", ["config", "user.name", "Forge Test"], { cwd: workspace });
    await run("git", ["config", "user.email", "forge@example.test"], { cwd: workspace });
    await writeFile(path.join(workspace, "staged.txt"), "staged\n", "utf8");
    await writeFile(path.join(workspace, "unstaged.txt"), "unstaged\n", "utf8");
    const { commitStagedChanges, createGitBranch, getGitStatus, switchGitBranch, updateGitIndex } = await import(`${moduleUrl}?workflow=${Date.now()}`);
    const before = await getGitStatus(workspace);
    assert.equal(before.isRepository, true);
    const originalBranch = before.branch;

    const staged = await updateGitIndex(workspace, ["staged.txt"], "stage");
    assert.equal(staged.changes.find((change) => change.path === "staged.txt")?.staged, true);
    assert.equal(staged.changes.find((change) => change.path === "unstaged.txt")?.staged, false);
    const unstagedAgain = await updateGitIndex(workspace, ["staged.txt"], "unstage");
    assert.equal(unstagedAgain.changes.find((change) => change.path === "staged.txt")?.staged, false);
    await updateGitIndex(workspace, ["staged.txt"], "stage");
    assert.equal(before.changes.find((change) => change.path === "unstaged.txt")?.unstaged, true);

    const committed = await commitStagedChanges(workspace, "test: staged only");
    assert.ok(committed.head);
    assert.equal(committed.commits[0]?.subject, "test: staged only");
    assert.equal(committed.changes.some((change) => change.path === "staged.txt"), false);
    assert.equal(committed.changes.some((change) => change.path === "unstaged.txt"), true);
    assert.equal(await readFile(path.join(workspace, "unstaged.txt"), "utf8"), "unstaged\n");
    await rm(path.join(workspace, "unstaged.txt"));

    const branched = await createGitBranch(workspace, "codex/checkpoint-test");
    assert.equal(branched.branch, "codex/checkpoint-test");
    assert.deepEqual(new Set(branched.branches.map((branch) => branch.name)), new Set([originalBranch, "codex/checkpoint-test"]));
    await writeFile(path.join(workspace, "dirty.txt"), "dirty\n", "utf8");
    await assert.rejects(() => switchGitBranch(workspace, originalBranch), /不会自动 stash/);
    await rm(path.join(workspace, "dirty.txt"));
    assert.equal((await switchGitBranch(workspace, originalBranch)).branch, originalBranch);
    await assert.rejects(() => updateGitIndex(workspace, [":(glob)*"], "stage"), /状态已经变化/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("commit refuses to auto-stage files", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "forge-git-no-stage-"));
  try {
    await run("git", ["init"], { cwd: workspace });
    await writeFile(path.join(workspace, "user.txt"), "leave me unstaged\n", "utf8");
    const { commitStagedChanges } = await import(`${moduleUrl}?nostage=${Date.now()}`);
    await assert.rejects(() => commitStagedChanges(workspace, "should not commit"), /不会自动暂存/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
