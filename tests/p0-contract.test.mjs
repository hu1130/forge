import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const matrixUrl = new URL(
  "../spikes/provider-contract/capability-matrix.json",
  import.meta.url,
);
const protocolV1Url = new URL(
  "../vendor/codex-schema/0.153.4/json/codex_app_server_protocol.schemas.json",
  import.meta.url,
);
const protocolV2Url = new URL(
  "../vendor/codex-schema/0.153.4/json/codex_app_server_protocol.v2.schemas.json",
  import.meta.url,
);

test("provider matrix covers every confirmed provider family", async () => {
  const matrix = JSON.parse(await readFile(matrixUrl, "utf8"));
  const ids = new Set(matrix.providers.map((provider) => provider.id));

  for (const required of [
    "openai",
    "anthropic",
    "gemini",
    "deepseek",
    "dashscope",
    "zhipu",
    "moonshot",
    "ollama",
  ]) {
    assert.ok(ids.has(required), `Missing provider contract: ${required}`);
  }
});

test("automatic provider fallback is forbidden", async () => {
  const matrix = JSON.parse(await readFile(matrixUrl, "utf8"));
  assert.equal(matrix.fallbackPolicy, "disabled");
});

test("provider contract requires streaming, tools, and cancellation", async () => {
  const matrix = JSON.parse(await readFile(matrixUrl, "utf8"));
  assert.deepEqual(matrix.requiredCapabilities, [
    "streamingText",
    "toolCalling",
    "cancellation",
  ]);
});

test("pinned App Server protocol exposes required product primitives", async () => {
  const protocol = [
    await readFile(protocolV1Url, "utf8"),
    await readFile(protocolV2Url, "utf8"),
  ].join("\n");

  for (const primitive of [
    "thread/start",
    "thread/resume",
    "turn/interrupt",
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "mcpServer/elicitation/request",
    "skills/list",
    "subagentStart",
    "subagentStop",
  ]) {
    assert.ok(protocol.includes(primitive), `Missing App Server primitive: ${primitive}`);
  }
});
