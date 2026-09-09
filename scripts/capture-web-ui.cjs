const { app, BrowserWindow } = require("electron");
const { mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const outputDir = path.join(projectRoot, "docs", "design");
const previewUrl = process.env.FORGE_PREVIEW_URL || "http://127.0.0.1:5173";

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function capture(window, filename) {
  await pause(500);
  const image = await window.webContents.capturePage();
  writeFileSync(path.join(outputDir, filename), image.toPNG());
}

app.whenReady().then(async () => {
  mkdirSync(outputDir, { recursive: true });
  const window = new BrowserWindow({
    show: false,
    frame: false,
    useContentSize: true,
    width: 1440,
    height: 900,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });

  await window.loadURL(previewUrl);
  await capture(window, "forge-workbench-structural-1440.png");

  window.setContentSize(1000, 700);
  await window.reload();
  await capture(window, "forge-workbench-structural-1000.png");

  window.setContentSize(1440, 900);
  await window.reload();
  await pause(500);
  await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="设置"]')?.click()`);
  await pause(200);
  await window.webContents.executeJavaScript(`
    const button = document.querySelectorAll('.settings-nav button')[1];
    button?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, view: window })
    );
  `);
  await pause(300);
  window.setContentSize(1439, 900);
  window.setContentSize(1440, 900);
  window.showInactive();
  await pause(250);
  await capture(window, "forge-marketplace-structural-1440.png");
  window.hide();

  window.destroy();
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
