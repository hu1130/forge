const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const temporaryData = mkdtempSync(path.join(os.tmpdir(), "forge-ui-smoke-"));
let daemon;

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("Could not reserve a UI smoke port");
  return port;
}

async function waitFor(check, message, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(100);
  }
  throw new Error(message);
}

async function stopDaemon() {
  if (!daemon || daemon.exitCode !== null) return;
  daemon.kill();
  await Promise.race([
    new Promise((resolve) => daemon.once("exit", resolve)),
    pause(3_000),
  ]);
}

app.whenReady().then(async () => {
  const port = await availablePort();
  const daemonEntry = path.join(projectRoot, "apps", "daemon", "dist", "server.js");
  daemon = spawn(process.execPath, [daemonEntry], {
    cwd: projectRoot,
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      DEEPSEEK_API_KEY: "",
      FORGE_DATA_DIR: temporaryData,
      FORGE_HOST: "127.0.0.1",
      FORGE_PORT: String(port),
      FORGE_SKIP_RUNTIME_PREWARM: "1",
      FORGE_WEB_ROOT: path.join(projectRoot, "apps", "web", "dist"),
      FORGE_WORKSPACE: projectRoot,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let daemonOutput = "";
  daemon.stdout.on("data", (chunk) => { daemonOutput += chunk.toString(); });
  daemon.stderr.on("data", (chunk) => { daemonOutput += chunk.toString(); });

  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch { return false; }
  }, `Forge Daemon did not start:\n${daemonOutput}`);

  let exportCalled = false;
  ipcMain.handle("forge:deepseek-status", () => ({ configured: false, encryptedStorage: true }));
  ipcMain.handle("forge:export-diagnostics", () => {
    exportCalled = true;
    return { saved: true };
  });

  const window = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(projectRoot, "apps", "desktop", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await window.loadURL(`http://127.0.0.1:${port}`);
  await waitFor(() => window.webContents.executeJavaScript("Boolean(document.querySelector('.app-shell, .onboarding-dialog'))"), "Forge UI did not render");
  await window.webContents.executeJavaScript(`
    [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('先使用演示模式'))?.click()
  `);
  await waitFor(() => window.webContents.executeJavaScript("Boolean(document.querySelector('.app-shell'))"), "Forge workbench did not render");
  await window.webContents.executeJavaScript("document.querySelector('.sidebar-settings')?.click()");
  await waitFor(() => window.webContents.executeJavaScript("Boolean(document.querySelector('.settings-screen'))"), "Forge settings did not open");
  await window.webContents.executeJavaScript(`
    [...document.querySelectorAll('.settings-nav button')].find((button) => button.textContent?.includes('运行时'))?.click()
  `);
  await waitFor(() => window.webContents.executeJavaScript("Boolean(document.querySelector('#runtime-diagnostics-title'))"), "Runtime diagnostics did not render");
  const exportButtonReady = await window.webContents.executeJavaScript(`
    (() => {
      const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('导出诊断信息'));
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()
  `);
  if (!exportButtonReady) throw new Error("Diagnostics export button is unavailable");
  await waitFor(() => window.webContents.executeJavaScript("document.body.innerText.includes('诊断信息已导出')"), "Diagnostics success state did not render");
  if (!exportCalled) throw new Error("Diagnostics IPC was not invoked");
  window.destroy();
  console.log("Forge UI smoke: workbench -> settings -> runtime -> diagnostics export ready");
  await stopDaemon();
  rmSync(temporaryData, { recursive: true, force: true });
  app.quit();
}).catch(async (error) => {
  console.error(error);
  await stopDaemon();
  rmSync(temporaryData, { recursive: true, force: true });
  app.exit(1);
});
