const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const temporaryData = mkdtempSync(path.join(os.tmpdir(), "forge-ui-smoke-"));
const captureDirectory = process.env.FORGE_UI_QA_CAPTURE_DIR?.trim() || "";
let daemon;

if (captureDirectory && !path.isAbsolute(captureDirectory)) throw new Error("FORGE_UI_QA_CAPTURE_DIR must be absolute");

async function capture(window, name) {
  if (!captureDirectory) return;
  mkdirSync(captureDirectory, { recursive: true });
  const wasVisible = window.isVisible();
  if (!wasVisible) window.showInactive();
  window.webContents.invalidate();
  await pause(80);
  const image = await window.webContents.capturePage();
  writeFileSync(path.join(captureDirectory, name), image.toPNG());
  if (!wasVisible) window.hide();
}

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
  let legalAccepted = false;
  let updateCalled = false;
  ipcMain.handle("forge:deepseek-status", () => ({ configured: false, encryptedStorage: true }));
  ipcMain.handle("forge:release-info", () => ({ version: "0.23.0-test", legalVersion: "2026-09-14", publisherName: "", privacyContact: "", supportUrl: "", updateConfigured: false, legalAccepted }));
  ipcMain.handle("forge:accept-legal", (_event, version) => {
    if (version !== "2026-09-14") throw new Error("Unexpected legal version");
    legalAccepted = true;
    return { version: "0.23.0-test", legalVersion: version, publisherName: "", privacyContact: "", supportUrl: "", updateConfigured: false, legalAccepted };
  });
  ipcMain.handle("forge:check-updates", () => {
    updateCalled = true;
    return { status: "unconfigured", currentVersion: "0.23.0-test" };
  });
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
  const consoleProblems = [];
  window.webContents.on("console-message", (_event, details, ...legacy) => {
    const level = typeof details === "object" ? details.level : details;
    const message = typeof details === "object" ? details.message : legacy[0];
    if (level === "error" || level === 2 || level === 3) consoleProblems.push(String(message || "unknown console error"));
  });
  await window.loadURL(`http://127.0.0.1:${port}`);
  await waitFor(() => window.webContents.executeJavaScript("Boolean(document.querySelector('.legal-consent-dialog'))"), "Legal consent did not render");
  const initialConsent = await window.webContents.executeJavaScript(`
    (() => {
      const accept = [...document.querySelectorAll('.legal-consent-dialog button')].find((button) => button.textContent?.includes('同意并继续'));
      return {
        acceptDisabled: Boolean(accept?.disabled),
        focusedText: document.activeElement?.textContent || '',
        overlay: Boolean(document.querySelector('vite-error-overlay, #webpack-dev-server-client-overlay')),
      };
    })()
  `);
  if (!initialConsent.acceptDisabled || !initialConsent.focusedText.includes("用户协议") || initialConsent.overlay) throw new Error("Legal consent initial accessibility state is invalid");
  await capture(window, "forge-legal-consent-desktop.png");
  window.webContents.setZoomFactor(2);
  await pause(150);
  const zoomLayout = await window.webContents.executeJavaScript(`
    (() => {
      const dialog = document.querySelector('.legal-consent-dialog')?.getBoundingClientRect();
      const action = [...document.querySelectorAll('.legal-consent-dialog button')].find((button) => button.textContent?.includes('同意并继续'))?.getBoundingClientRect();
      return { innerHeight, dialog: dialog && { top: dialog.top, bottom: dialog.bottom, height: dialog.height }, action: action && { top: action.top, bottom: action.bottom, height: action.height } };
    })()
  `);
  await window.webContents.executeJavaScript(`
    document.querySelector('.legal-consent-dialog input[type="checkbox"]')?.click()
  `);
  await pause(80);
  await window.webContents.executeJavaScript(`
    [...document.querySelectorAll('.legal-consent-dialog button')].find((button) => button.textContent?.includes('同意并继续'))?.focus()
  `);
  await pause(80);
  await capture(window, "forge-legal-consent-200-percent.png");
  const zoomActionVisible = await window.webContents.executeJavaScript(`
    (() => {
      const dialog = document.querySelector('.legal-consent-dialog')?.getBoundingClientRect();
      const active = document.activeElement;
      const action = active?.getBoundingClientRect();
      return Boolean(dialog && action && active?.textContent?.includes('同意并继续') && action.top >= dialog.top && action.bottom <= dialog.bottom && action.top >= 0 && action.bottom <= innerHeight);
    })()
  `);
  if (!zoomLayout.dialog || zoomLayout.dialog.top < 0 || zoomLayout.dialog.bottom > zoomLayout.innerHeight || !zoomActionVisible) {
    throw new Error(`Legal consent does not remain operable at 200% zoom: ${JSON.stringify(zoomLayout)}`);
  }
  await window.webContents.executeJavaScript(`document.querySelector('.legal-consent-dialog input[type="checkbox"]')?.click()`);
  window.webContents.setZoomFactor(1);
  await pause(100);
  const consentReady = await window.webContents.executeJavaScript(`
    (() => {
      const privacy = [...document.querySelectorAll('.legal-document-tabs button')].find((button) => button.textContent?.includes('隐私说明'));
      privacy?.click();
      const checkbox = document.querySelector('.legal-consent-dialog input[type="checkbox"]');
      if (!checkbox) return false;
      checkbox.click();
      [...document.querySelectorAll('.legal-consent-dialog button')].find((button) => button.textContent?.includes('同意并继续'))?.click();
      return true;
    })()
  `);
  if (!consentReady) throw new Error("Legal consent controls are unavailable");
  await waitFor(() => window.webContents.executeJavaScript("!document.querySelector('.legal-consent-dialog')"), "Legal consent did not close after acceptance");
  if (!legalAccepted) throw new Error("Legal consent IPC was not invoked");
  await waitFor(() => window.webContents.executeJavaScript("Boolean(document.querySelector('.app-shell, .onboarding-dialog'))"), "Forge UI did not render");
  await window.webContents.executeJavaScript(`
    [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('先使用演示模式'))?.click()
  `);
  await waitFor(() => window.webContents.executeJavaScript("Boolean(document.querySelector('.app-shell'))"), "Forge workbench did not render");
  await window.webContents.executeJavaScript("document.querySelector('.sidebar-settings')?.click()");
  await waitFor(() => window.webContents.executeJavaScript("Boolean(document.querySelector('.settings-screen'))"), "Forge settings did not open");
  await window.webContents.executeJavaScript(`
    [...document.querySelectorAll('.settings-nav button')].find((button) => button.textContent?.includes('关于 Forge'))?.click()
  `);
  await waitFor(() => window.webContents.executeJavaScript("Boolean(document.querySelector('#release-update-title'))"), "Release settings did not render");
  await capture(window, "forge-about-desktop.png");
  await window.webContents.executeJavaScript(`
    [...document.querySelectorAll('.release-update button')].find((button) => button.textContent?.includes('检查更新'))?.click()
  `);
  await waitFor(() => window.webContents.executeJavaScript("document.body.innerText.includes('发行版尚未配置更新服务')"), "Unconfigured update state did not render");
  if (!updateCalled) throw new Error("Update IPC was not invoked");
  window.setBounds({ width: 760, height: 720 });
  await pause(180);
  const narrowLayout = await window.webContents.executeJavaScript(`
    (() => {
      const settings = document.querySelector('.settings-screen')?.getBoundingClientRect();
      const update = document.querySelector('.release-update')?.getBoundingClientRect();
      const pixelTolerance = 1;
      return {
        valid: Boolean(settings && update
          && settings.left >= -pixelTolerance
          && settings.right <= innerWidth + pixelTolerance
          && update.left >= settings.left - pixelTolerance
          && update.right <= settings.right + pixelTolerance),
        innerWidth,
        settings: settings && { left: settings.left, right: settings.right, width: settings.width },
        update: update && { left: update.left, right: update.right, width: update.width },
      };
    })()
  `);
  if (!narrowLayout.valid) throw new Error(`Release settings overflow the supported narrow viewport: ${JSON.stringify(narrowLayout)}`);
  await capture(window, "forge-about-narrow.png");
  window.setBounds({ width: 1200, height: 800 });
  await pause(120);
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
  if (consoleProblems.length) throw new Error(`Forge UI console errors:\n${consoleProblems.join("\n")}`);
  window.destroy();
  console.log("Forge UI smoke: legal consent -> about/update -> runtime/diagnostics ready");
  await stopDaemon();
  rmSync(temporaryData, { recursive: true, force: true });
  app.quit();
}).catch(async (error) => {
  console.error(error);
  await stopDaemon();
  rmSync(temporaryData, { recursive: true, force: true });
  app.exit(1);
});
