import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("first run onboarding exposes workspace, API test, save, and demo paths", async () => {
  await access("apps/web/src/OnboardingDialog.tsx");
  const onboarding = await readFile("apps/web/src/OnboardingDialog.tsx", "utf8");
  const app = await readFile("apps/web/src/App.tsx", "utf8");
  assert.match(onboarding, /选择工作区/);
  assert.match(onboarding, /测试连接/);
  assert.match(onboarding, /保存并开始/);
  assert.match(onboarding, /先使用演示模式/);
  assert.match(app, /forge:onboarding-dismissed:v1/);
});

test("DeepSeek connection test stays in the trusted desktop process", async () => {
  const main = await readFile("apps/desktop/main.cjs", "utf8");
  const preload = await readFile("apps/desktop/preload.cjs", "utf8");
  assert.match(main, /new URL\("models"/);
  assert.match(main, /AbortSignal\.timeout\(12_000\)/);
  assert.match(main, /forge:test-deepseek-key/);
  assert.match(preload, /forge:test-deepseek-key/);
  assert.doesNotMatch(main, /console\.(?:log|error)\([^\n]*key/i);
});

test("tasks can be archived, restored, and only then permanently deleted", async () => {
  const contracts = await readFile("packages/contracts/src/index.ts", "utf8");
  const server = await readFile("apps/daemon/src/server.ts", "utf8");
  const app = await readFile("apps/web/src/App.tsx", "utf8");
  assert.match(contracts, /archived\?: boolean/);
  assert.match(server, /archived: request\.body\?\.archived/);
  assert.match(app, /归档任务/);
  assert.match(app, /恢复任务/);
  assert.match(app, /永久删除/);
});

test("change review exposes conflict-checked revert and reapply", async () => {
  const manager = await readFile("apps/daemon/src/change-manager.ts", "utf8");
  const server = await readFile("apps/daemon/src/server.ts", "utf8");
  const app = await readFile("apps/web/src/App.tsx", "utf8");
  assert.match(manager, /--check/);
  assert.match(manager, /--reverse/);
  assert.doesNotMatch(manager, /--unsafe-paths/);
  assert.match(server, /\/api\/tasks\/:id\/changes/);
  assert.match(app, /重新应用/);
});
