import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Git workflow exposes explicit index and branch switching APIs", async () => {
  const manager = await readFile("apps/daemon/src/git-manager.ts", "utf8");
  const server = await readFile("apps/daemon/src/server.ts", "utf8");
  assert.match(manager, /export async function updateGitIndex/);
  assert.match(manager, /export async function switchGitBranch/);
  assert.match(manager, /不会自动 stash 或强制切换分支/);
  assert.match(server, /\/api\/git\/index/);
  assert.match(server, /\/api\/git\/switch/);
});

test("Git status includes branches and recent commits", async () => {
  const contracts = await readFile("packages/contracts/src/index.ts", "utf8");
  const manager = await readFile("apps/daemon/src/git-manager.ts", "utf8");
  assert.match(contracts, /branches: GitBranchInfo\[\]/);
  assert.match(contracts, /commits: GitCommitInfo\[\]/);
  assert.match(manager, /\["log", "-n", "8"/);
});

test("Git panel separates staged and unstaged selections", async () => {
  const panel = await readFile("apps/web/src/GitPanel.tsx", "utf8");
  assert.match(panel, /暂存所选/);
  assert.match(panel, /取消暂存/);
  assert.match(panel, /切换本地分支/);
  assert.match(panel, /最近提交/);
  assert.match(panel, /type="checkbox"/);
  assert.match(panel, /工作区有未提交变更/);
});
