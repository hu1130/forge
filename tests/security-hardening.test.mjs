import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function availablePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  server.close();
  await once(server, "close");
  return port;
}

async function waitForHealth(url, token) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    try {
      const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      if (response.ok) return;
    } catch { /* Daemon is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("test daemon did not start");
}

test("packaged daemon requires an ephemeral local session token", async () => {
  const daemon = await readFile("apps/daemon/src/server.ts", "utf8");
  const desktop = await readFile("apps/desktop/main.cjs", "utf8");

  assert.match(daemon, /FORGE_API_TOKEN/);
  assert.match(daemon, /timingSafeEqual/);
  assert.match(daemon, /forge_session/);
  assert.match(desktop, /randomBytes\(32\)/);
  assert.match(desktop, /FORGE_API_TOKEN: apiToken/);
  assert.match(desktop, /httpOnly: true/);
});

test("daemon rejects API requests without its configured session token", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "forge-auth-"));
  const webRoot = path.join(dataDir, "web");
  const port = await availablePort();
  const token = "forge-test-session-token";
  await mkdir(webRoot, { recursive: true });
  await writeFile(path.join(webRoot, "index.html"), "<!doctype html><title>Forge test</title>", "utf8");

  const child = spawn(process.execPath, [path.resolve("apps/daemon/dist/server.js")], {
    env: {
      ...process.env,
      FORGE_API_TOKEN: token,
      FORGE_CODEX_BIN: path.join(dataDir, "missing-codex.exe"),
      FORGE_DATA_DIR: dataDir,
      FORGE_HOST: "127.0.0.1",
      FORGE_PORT: String(port),
      FORGE_WEB_ROOT: webRoot,
      FORGE_WORKSPACE: dataDir,
    },
    stdio: "ignore",
  });

  try {
    const healthUrl = `http://127.0.0.1:${port}/api/health`;
    await waitForHealth(healthUrl, token);
    const session = await fetch(`http://127.0.0.1:${port}/api/session`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(session.status, 200);
    assert.deepEqual(await session.json(), { protected: true });
    assert.equal((await fetch(healthUrl)).status, 401);
    assert.equal((await fetch(healthUrl, { headers: { authorization: `Bearer ${token}` } })).status, 200);
    assert.equal((await fetch(healthUrl, { headers: { cookie: `forge_session=${token}` } })).status, 200);
  } finally {
    child.kill();
    await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3_000))]);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("Electron renderer permissions, navigation and IPC are constrained", async () => {
  const desktop = await readFile("apps/desktop/main.cjs", "utf8");
  const html = await readFile("apps/web/index.html", "utf8");

  assert.match(desktop, /contextIsolation: true/);
  assert.match(desktop, /nodeIntegration: false/);
  assert.match(desktop, /sandbox: true/);
  assert.match(desktop, /setPermissionRequestHandler/);
  assert.match(desktop, /will-navigate/);
  assert.match(desktop, /assertTrustedSender\(event\)/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /object-src 'none'/);
});
