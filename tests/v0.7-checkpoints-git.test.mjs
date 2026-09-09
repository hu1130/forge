import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("App Server turn diffs are persisted as independent checkpoints", async () => {
  const server = await readFile("apps/daemon/src/server.ts", "utf8");
  const contracts = await readFile("packages/contracts/src/index.ts", "utf8");
  assert.match(server, /turn\/diff\/updated/);
  assert.match(server, /\/api\/tasks\/:id\/checkpoints\/:turnId/);
  assert.match(contracts, /turnId\?: string/);
  assert.doesNotMatch(server, /thread\/rollback/);
});

test("Git mutations use argv spawning and never auto-stage", async () => {
  const manager = await readFile("apps/daemon/src/git-manager.ts", "utf8");
  assert.match(manager, /spawn\("git", args/);
  assert.match(manager, /shell: false/);
  assert.match(manager, /\["switch", "-c", name\]/);
  assert.match(manager, /没有已暂存的变更/);
  assert.match(manager, /--literal-pathspecs/);
  const commitFunction = manager.slice(manager.indexOf("export async function commitStagedChanges"));
  assert.doesNotMatch(commitFunction, /\["--literal-pathspecs", "add"/);
});

test("the UI exposes per-turn undo and a dedicated Git panel", async () => {
  const app = await readFile("apps/web/src/App.tsx", "utf8");
  const panel = await readFile("apps/web/src/GitPanel.tsx", "utf8");
  assert.match(app, /撤销本轮/);
  assert.match(app, /重新应用本轮/);
  assert.match(app, /inspectorTab === "git"/);
  assert.match(panel, /提交已暂存内容/);
  assert.match(panel, /Forge 不会自动暂存/);
});
