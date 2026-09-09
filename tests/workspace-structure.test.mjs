import { access, readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";

test("frontend, daemon and desktop entrypoints exist", async () => {
  await Promise.all([
    access("apps/web/src/App.tsx"),
    access("apps/daemon/src/server.ts"),
    access("apps/desktop/main.cjs"),
    access("packages/contracts/src/index.ts"),
  ]);
});

test("daemon rejects implicit provider fallback", async () => {
  const source = await readFile("apps/daemon/src/server.ts", "utf8");
  assert.match(source, /未执行自动降级/);
  assert.match(source, /providerId !== "demo"/);
});

test("desktop shell keeps node integration disabled", async () => {
  const source = await readFile("apps/desktop/main.cjs", "utf8");
  assert.match(source, /nodeIntegration: false/);
  assert.match(source, /contextIsolation: true/);
  assert.match(source, /sandbox: true/);
});
