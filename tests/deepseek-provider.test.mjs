import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("DeepSeek catalog exposes the supported Codex models", async () => {
  const catalog = JSON.parse(await readFile("apps/daemon/resources/deepseek-models.json", "utf8"));
  const models = new Map(catalog.models.map((model) => [model.slug, model]));

  for (const slug of ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-vision-exp"]) {
    const model = models.get(slug);
    assert.ok(model, `Missing DeepSeek model: ${slug}`);
    assert.equal(model.apply_patch_tool_type, "freeform");
    assert.ok(Array.isArray(model.experimental_supported_tools));
    assert.equal(typeof model.base_instructions, "string");
  }
});

test("DeepSeek configuration reads the key from the environment", async () => {
  const source = await readFile("apps/daemon/src/deepseek.ts", "utf8");
  assert.match(source, /model_providers\.deepseek\.env_key/);
  assert.match(source, /DEEPSEEK_API_KEY/);
  assert.doesNotMatch(source, /experimental_bearer_token/);
});

test("DeepSeek turns use App Server and support interruption", async () => {
  const source = await readFile("apps/daemon/src/server.ts", "utf8");
  assert.match(source, /bridge\.request\("thread\/start"/);
  assert.match(source, /bridge\.request\("thread\/resume"/);
  assert.match(source, /bridge\.request\("turn\/start"/);
  assert.match(source, /bridge\.request\("turn\/interrupt"/);
  assert.match(source, /ephemeral: false/);
  assert.match(source, /setAgentSession/);
  assert.match(source, /providerId === "deepseek"/);
});

test("DeepSeek approval requests are surfaced instead of silently declined", async () => {
  const source = await readFile("apps/daemon/src/server.ts", "utf8");
  const contracts = await readFile("packages/contracts/src/index.ts", "utf8");
  assert.match(source, /approvalPolicy: store\.preferences\(\)\.approvalPolicy/);
  assert.match(source, /app\.patch<\{ Body: Partial<WorkspacePreferences> \}>/);
  assert.match(contracts, /ForgeApprovalPolicy = "untrusted" \| "on-request"/);
  assert.match(source, /approvalsReviewer: "user"/);
  assert.match(source, /\/api\/approvals\/:id/);
  assert.doesNotMatch(source, /requestApproval"\) \{\s*bridge\.respond\(message\.id, \{ decision: "decline" \}\)/);
});

test("file activities retain their real patch content", async () => {
  const contracts = await readFile("packages/contracts/src/index.ts", "utf8");
  const parser = await readFile("apps/daemon/src/unified-diff.ts", "utf8");
  const web = await readFile("apps/web/src/App.tsx", "utf8");
  assert.match(contracts, /diff\?: string/);
  assert.match(parser, /additions, deletions, diff/);
  assert.match(web, /file\.diff/);
  assert.doesNotMatch(web, /<h1&gt;Welcome<\/h1&gt;/);
});
