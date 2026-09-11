const { app, BrowserWindow } = require("electron");
const { mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const outputDir = path.join(projectRoot, "docs", "design");
const previewUrl = process.env.FORGE_PREVIEW_URL || "http://127.0.0.1:5173";
const cloudAccountBootstrapUrl = process.env.FORGE_CAPTURE_CLOUD_ACCOUNT_URL || "";
const capturePartition = `forge-capture-${process.pid}`;

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForSettledUi(window, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const ready = await window.webContents.executeJavaScript(`
      Boolean(document.querySelector('.cloud-auth-shell, .app-shell'))
    `);
    if (ready) return true;
    await pause(100);
  }
  return false;
}

async function waitForSelector(window, selector, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) return true;
    await pause(100);
  }
  return false;
}

async function capture(window, filename) {
  if (!await waitForSettledUi(window)) {
    const state = await window.webContents.executeJavaScript("document.body.innerText.slice(0, 500)");
    throw new Error(`UI did not settle before ${filename}: ${state}`);
  }
  window.showInactive();
  window.webContents.invalidate();
  await pause(300);
  const image = await window.webContents.capturePage();
  writeFileSync(path.join(outputDir, filename), image.toPNG());
  window.hide();
}

function createWindow(width, height) {
  return new BrowserWindow({
    show: false,
    frame: false,
    useContentSize: true,
    width,
    height,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, partition: capturePartition },
  });
}

app.whenReady().then(async () => {
  mkdirSync(outputDir, { recursive: true });
  const windows = [];
  let window = createWindow(1440, 900);
  windows.push(window);
  await window.loadURL(previewUrl);
  if (!await waitForSettledUi(window)) throw new Error("Preview UI did not settle before the first capture");
  const previewIsCloudAuth = await window.webContents.executeJavaScript("Boolean(document.querySelector('.cloud-auth-shell'))");
  await capture(window, previewIsCloudAuth ? "forge-cloud-login-1440.png" : "forge-workbench-structural-1440.png");

  window = createWindow(1000, 700);
  windows.push(window);
  await window.loadURL(previewUrl);
  await capture(window, previewIsCloudAuth ? "forge-cloud-login-1000.png" : "forge-workbench-structural-1000.png");

  window = createWindow(1440, 900);
  windows.push(window);
  await window.loadURL(previewUrl);
  if (!await waitForSettledUi(window)) throw new Error("Preview UI did not settle before interaction capture");
  if (previewIsCloudAuth) {
    await window.webContents.executeJavaScript(`
      [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('忘记密码'))?.click()
    `);
    if (!await waitForSelector(window, "#cloud-auth-title")) throw new Error("Forgot-password UI did not render");
    await capture(window, "forge-cloud-forgot-password-1440.png");

    const resetUrl = new URL(previewUrl);
    resetUrl.searchParams.set("reset", "A".repeat(43));
    window = createWindow(1000, 700);
    windows.push(window);
    await window.loadURL(resetUrl.toString());
    await capture(window, "forge-cloud-reset-password-1000.png");
  } else {
    await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="设置"]')?.click()`);
    await pause(200);
    await window.webContents.executeJavaScript(`
      const button = document.querySelectorAll('.settings-nav button')[1];
      button?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, view: window })
      );
    `);
    await pause(300);
    await capture(window, "forge-marketplace-structural-1440.png");
  }

  if (cloudAccountBootstrapUrl) {
    window = createWindow(1440, 900);
    windows.push(window);
    await window.loadURL(cloudAccountBootstrapUrl);
    if (!await waitForSelector(window, ".app-shell", 10000)) {
      const state = await window.webContents.executeJavaScript("`${location.href} | ${document.body.innerText.slice(0, 300)}`");
      throw new Error(`Cloud account workspace did not render: ${state}`);
    }
    await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="稍后配置"]')?.click()`);
    await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="设置"]')?.click()`);
    if (!await waitForSelector(window, "#cloud-session-title", 10000)) throw new Error("Cloud session management did not render");
    await capture(window, "forge-cloud-account-security-1440.png");
  }

  for (const openWindow of windows) openWindow.destroy();
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
