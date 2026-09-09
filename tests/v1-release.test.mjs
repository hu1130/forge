import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("v1 exposes project, task, approval, and terminal APIs", async () => {
  const source = await readFile("apps/daemon/src/server.ts", "utf8");
  for (const route of [
    "/api/workspace",
    "/api/tasks/:id",
    "/api/approvals/:id",
    "/api/terminals",
    "/api/terminals/:id/stream",
  ]) {
    assert.ok(source.includes(route), `Missing release API: ${route}`);
  }
  assert.match(source, /app\.patch<\{/);
  assert.match(source, /app\.delete<\{ Params: \{ id: string \} \}>\("\/api\/tasks\/:id"/);
});

test("fresh installs start without fake task history", async () => {
  const source = await readFile("apps/daemon/src/task-store.ts", "utf8");
  assert.match(source, /tasks: \[\]/);
  assert.doesNotMatch(source, /id: "vertical-slice"/);
});

test("desktop stores provider keys with Windows encryption", async () => {
  const source = await readFile("apps/desktop/main.cjs", "utf8");
  assert.match(source, /safeStorage\.encryptString/);
  assert.match(source, /safeStorage\.decryptString/);
  assert.match(source, /secure-config\.json/);
  assert.match(source, /contextIsolation: true/);
  assert.doesNotMatch(source, /spawn\([^\n]+apiKey/);
});

test("Forge isolates Codex state and encrypts MCP bearer tokens", async () => {
  const desktop = await readFile("apps/desktop/main.cjs", "utf8");
  const bridge = await readFile("apps/daemon/src/codex-bridge.ts", "utf8");
  const extensions = await readFile("apps/daemon/src/extension-store.ts", "utf8");
  assert.match(desktop, /FORGE_CODEX_HOME/);
  assert.match(bridge, /CODEX_HOME: codexHome/);
  assert.match(desktop, /safeStorage\.encryptString\(token\)/);
  assert.match(extensions, /bearer_token_env_var/);
  assert.doesNotMatch(extensions, /bearerToken:\s*string/);
});

test("Skills and MCP expose management APIs and App Server discovery", async () => {
  const server = await readFile("apps/daemon/src/server.ts", "utf8");
  const catalog = JSON.parse(await readFile("apps/daemon/resources/deepseek-models.json", "utf8"));
  for (const route of ["/api/extensions", "/api/skills/import", "/api/skills/:id", "/api/mcp/servers", "/api/mcp/servers/:name", "/api/mcp/refresh"]) {
    assert.ok(server.includes(route), `Missing extension API: ${route}`);
  }
  assert.match(server, /skills\/extraRoots\/set/);
  assert.match(server, /skills\/list/);
  assert.match(server, /mcpServerStatus\/list/);
  assert.match(server, /shell_environment_policy\.ignore_default_excludes=false/);
  assert.match(server, /FORGE_MCP_TOKEN_\*/);
  assert.ok(catalog.models.every((model) => model.include_skills_usage_instructions === true));
});

test("MCP tool calls are preserved as collapsed conversation activities", async () => {
  const contracts = await readFile("packages/contracts/src/index.ts", "utf8");
  const server = await readFile("apps/daemon/src/server.ts", "utf8");
  const web = await readFile("apps/web/src/App.tsx", "utf8");
  assert.match(contracts, /kind: "tool"/);
  assert.match(server, /item\.type !== "mcpToolCall"/);
  assert.match(web, /MCP 工具调用/);
});

test("MCP tool approvals use the app-server elicitation protocol", async () => {
  const contracts = await readFile("packages/contracts/src/index.ts", "utf8");
  const server = await readFile("apps/daemon/src/server.ts", "utf8");
  const web = await readFile("apps/web/src/App.tsx", "utf8");
  assert.match(contracts, /kind: "command" \| "files" \| "mcp"/);
  assert.match(server, /mcpServer\/elicitation\/request/);
  assert.match(server, /codex_approval_kind === "mcp_tool_call"/);
  assert.match(server, /persist: "session"/);
  assert.match(web, /允许调用这个 MCP 工具/);
});

test("Windows package includes its daemon, Codex runtime, and notices", async () => {
  const desktopPackage = JSON.parse(await readFile("apps/desktop/package.json", "utf8"));
  const resources = desktopPackage.build.extraResources.map((entry) => entry.to);
  assert.deepEqual(resources, ["web", "codex", "daemon", "daemon/node_modules/node-pty", "licenses"]);
  assert.equal(desktopPackage.build.win.artifactName, "Forge-Setup-${version}.${ext}");
  const prepare = await readFile("scripts/prepare-codex-bundle.mjs", "utf8");
  assert.match(prepare, /FORGE_CODEX_SOURCE_DIR/);
  assert.match(prepare, /external: \["node-pty"\]/);
  assert.match(prepare, /apps", "daemon", "resources/);
  await access("apps/daemon/resources/deepseek-models.json");
  await access("apps/daemon/resources/marketplace.json");
});

test("terminal UI is split into an on-demand chunk", async () => {
  const app = await readFile("apps/web/src/App.tsx", "utf8");
  assert.match(app, /lazy\(\(\) => import\("\.\/TerminalPanel"\)\)/);
  assert.match(app, /<Suspense/);
});
