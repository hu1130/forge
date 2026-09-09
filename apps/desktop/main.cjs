const { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell } = require("electron");
const { randomBytes } = require("node:crypto");
const { spawn } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const path = require("node:path");

app.setName("Forge");

const webUrl = process.env.FORGE_WEB_URL || (app.isPackaged ? "http://127.0.0.1:4782" : "http://127.0.0.1:5173");
const smokeTest = process.env.FORGE_SMOKE_TEST === "1";
const apiToken = process.env.FORGE_API_TOKEN?.trim() || randomBytes(32).toString("base64url");
let daemonProcess = null;
let daemonFailure = "";

function assertTrustedSender(event) {
  const senderUrl = event.senderFrame?.url || event.sender.getURL();
  if (!senderUrl || new URL(senderUrl).origin !== new URL(webUrl).origin) throw new Error("拒绝来自非 Forge 页面的方法调用");
}

function secureConfigPath() {
  return path.join(app.getPath("userData"), "secure-config.json");
}

function readSecureConfig() {
  try {
    return JSON.parse(readFileSync(secureConfigPath(), "utf8"));
  } catch {
    return { version: 1 };
  }
}

function readDeepSeekApiKey() {
  const fromEnvironment = process.env.DEEPSEEK_API_KEY?.trim();
  if (fromEnvironment) return fromEnvironment;
  const encrypted = readSecureConfig().deepseekApiKey;
  if (!encrypted || !safeStorage.isEncryptionAvailable()) return "";
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
  } catch {
    return "";
  }
}

async function testDeepSeekApiKey(value) {
  const key = typeof value === "string" && value.trim() ? value.trim() : readDeepSeekApiKey();
  if (!/^sk-[A-Za-z0-9_-]{12,}$/.test(key)) throw new Error("请先输入有效的 DeepSeek API Key");
  const baseUrl = process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com/";
  const endpoint = new URL("models", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(endpoint, {
      headers: { authorization: `Bearer ${key}` },
      redirect: "error",
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    if (error?.name === "TimeoutError") throw new Error("连接 DeepSeek 超时，请检查网络后重试");
    throw new Error("无法连接 DeepSeek，请检查网络或代理设置");
  }
  if (response.status === 401 || response.status === 403) throw new Error("DeepSeek API Key 无效或已失效");
  if (response.status === 429) throw new Error("DeepSeek 请求过于频繁，请稍后重试");
  if (!response.ok) throw new Error(`DeepSeek 连通测试失败（HTTP ${response.status}）`);
  const payload = await response.json().catch(() => null);
  const models = payload && Array.isArray(payload.data) ? payload.data : null;
  if (!models) throw new Error("DeepSeek 返回了无法识别的响应");
  return { ok: true, latencyMs: Date.now() - startedAt, modelCount: models.length };
}

function writeDeepSeekApiKey(apiKey) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("当前 Windows 环境无法使用系统加密存储");
  const filePath = secureConfigPath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  const config = readSecureConfig();
  config.version = 1;
  config.deepseekApiKey = safeStorage.encryptString(apiKey).toString("base64");
  const temporary = `${filePath}.tmp`;
  writeFileSync(temporary, JSON.stringify(config), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, filePath);
}

function mcpTokenEnvVar(name) {
  return `FORGE_MCP_TOKEN_${name.toUpperCase().replaceAll("-", "_")}`;
}

function readMcpTokens() {
  if (!safeStorage.isEncryptionAvailable()) return {};
  const encryptedTokens = readSecureConfig().mcpTokens;
  if (!encryptedTokens || typeof encryptedTokens !== "object" || Array.isArray(encryptedTokens)) return {};
  const tokens = {};
  for (const [name, encrypted] of Object.entries(encryptedTokens)) {
    if (typeof encrypted !== "string") continue;
    try { tokens[name] = safeStorage.decryptString(Buffer.from(encrypted, "base64")); } catch { /* Ignore unreadable entries. */ }
  }
  return tokens;
}

function writeMcpToken(name, token) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("当前 Windows 环境无法使用系统加密存储");
  if (!/^[a-z0-9](?:[a-z0-9_-]{0,38}[a-z0-9])?$/.test(name)) throw new Error("MCP 名称无效");
  if (!token || token.length > 4096) throw new Error("MCP 令牌无效");
  const filePath = secureConfigPath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  const config = readSecureConfig();
  config.version = 1;
  config.mcpTokens = config.mcpTokens && typeof config.mcpTokens === "object" && !Array.isArray(config.mcpTokens) ? config.mcpTokens : {};
  config.mcpTokens[name] = safeStorage.encryptString(token).toString("base64");
  const temporary = `${filePath}.tmp`;
  writeFileSync(temporary, JSON.stringify(config), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, filePath);
}

function deleteMcpToken(name) {
  const filePath = secureConfigPath();
  const config = readSecureConfig();
  if (!config.mcpTokens || typeof config.mcpTokens !== "object" || Array.isArray(config.mcpTokens) || !(name in config.mcpTokens)) return;
  delete config.mcpTokens[name];
  const temporary = `${filePath}.tmp`;
  writeFileSync(temporary, JSON.stringify(config), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, filePath);
}

function daemonEntryPath() {
  return path.join(process.resourcesPath, "daemon", "server.mjs");
}

function bundledCodexPath() {
  return path.join(process.resourcesPath, "codex", "codex.exe");
}

function startDaemon() {
  if (!app.isPackaged || daemonProcess) return;
  const entry = daemonEntryPath();
  if (!existsSync(entry)) throw new Error(`Forge Daemon 文件不存在：${entry}`);
  const codex = bundledCodexPath();
  if (!existsSync(codex)) throw new Error(`Codex CLI 文件不存在：${codex}`);
  const apiKey = readDeepSeekApiKey();
  const daemonEnvironment = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    FORGE_DATA_DIR: path.join(app.getPath("userData"), "daemon"),
    FORGE_CODEX_HOME: path.join(app.getPath("userData"), "codex"),
    FORGE_WEB_ROOT: path.join(process.resourcesPath, "web"),
    FORGE_WORKSPACE: app.getPath("documents"),
    FORGE_CODEX_BIN: codex,
    FORGE_API_TOKEN: apiToken,
    DEEPSEEK_API_KEY: apiKey || "",
  };
  for (const [name, token] of Object.entries(readMcpTokens())) daemonEnvironment[mcpTokenEnvVar(name)] = token;
  daemonFailure = "";
  daemonProcess = spawn(process.execPath, [entry], {
    env: daemonEnvironment,
    stdio: "ignore",
    windowsHide: true,
  });
  daemonProcess.once("error", (error) => { daemonFailure = error.message; });
  daemonProcess.once("exit", (code) => {
    if (code && !daemonFailure) daemonFailure = `Forge Daemon 已退出（${code}）`;
    daemonProcess = null;
  });
}

function stopDaemon() {
  const child = daemonProcess;
  daemonProcess = null;
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
}

async function restartDaemon() {
  if (!app.isPackaged) return false;
  await stopDaemon();
  startDaemon();
  return true;
}

async function waitForDaemon(timeoutMs = 20_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (daemonFailure) throw new Error(daemonFailure);
    try {
      const response = await fetch("http://127.0.0.1:4782/api/session", { headers: { authorization: `Bearer ${apiToken}` } });
      if (response.ok && (await response.json()).protected === true) return;
    } catch {
      // The daemon is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Forge Daemon 启动超时");
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#f4f6f8",
    title: "Forge",
    show: !smokeTest,
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#ffffff",
      symbolColor: "#343943",
      height: 58,
    },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (smokeTest) {
    window.webContents.once("did-finish-load", () => {
      console.log("Forge desktop smoke: ready");
      app.quit();
    });
    window.webContents.once("did-fail-load", (_event, code, description) => {
      console.error(`Forge desktop smoke failed: ${code} ${description}`);
      app.exit(1);
    });
  }

  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (target.protocol === "https:") void shell.openExternal(target.href);
    } catch { /* Reject malformed external URLs. */ }
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, navigationUrl) => {
    try {
      if (new URL(navigationUrl).origin !== new URL(webUrl).origin) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  window.loadURL(webUrl);
}

async function initializeApp() {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  await session.defaultSession.cookies.set({ url: webUrl, name: "forge_session", value: apiToken, httpOnly: true, sameSite: "strict", path: "/" });

  ipcMain.handle("forge:select-workspace", async (event) => {
    assertTrustedSender(event);
    const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? null : result.filePaths[0] || null;
  });
  ipcMain.handle("forge:select-skill-directory", async (event) => {
    assertTrustedSender(event);
    const result = await dialog.showOpenDialog({ title: "选择包含 SKILL.md 的文件夹", properties: ["openDirectory"] });
    return result.canceled ? null : result.filePaths[0] || null;
  });
  ipcMain.handle("forge:deepseek-status", (event) => {
    assertTrustedSender(event);
    return { configured: Boolean(readDeepSeekApiKey()), encryptedStorage: safeStorage.isEncryptionAvailable() };
  });
  ipcMain.handle("forge:test-deepseek-key", async (event, value) => {
    assertTrustedSender(event);
    return testDeepSeekApiKey(value);
  });
  ipcMain.handle("forge:save-deepseek-key", async (event, value) => {
    assertTrustedSender(event);
    const apiKey = typeof value === "string" ? value.trim() : "";
    if (!/^sk-[A-Za-z0-9_-]{12,}$/.test(apiKey)) throw new Error("请输入有效的 DeepSeek API Key");
    writeDeepSeekApiKey(apiKey);
    const restarted = await restartDaemon();
    if (restarted) await waitForDaemon();
    return { configured: true, restarted };
  });
  ipcMain.handle("forge:save-mcp-token", (event, name, value) => {
    assertTrustedSender(event);
    const token = typeof value === "string" ? value.trim() : "";
    writeMcpToken(String(name || ""), token);
    return { configured: true, envVar: mcpTokenEnvVar(String(name)) };
  });
  ipcMain.handle("forge:delete-mcp-token", (event, name) => {
    assertTrustedSender(event);
    deleteMcpToken(String(name || ""));
    return { configured: false };
  });
  ipcMain.handle("forge:restart-runtime", async (event) => {
    assertTrustedSender(event);
    const restarted = await restartDaemon();
    if (restarted) await waitForDaemon();
    return { restarted };
  });

  if (app.isPackaged) {
    try {
      startDaemon();
      await waitForDaemon();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (smokeTest) console.error(`Forge desktop smoke failed: ${message}`);
      else dialog.showErrorBox("Forge 启动失败", `${message}\n\n请重新安装 Forge；如果问题仍然存在，请联系软件提供者。`);
      app.exit(1);
      return;
    }
  }
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.whenReady().then(initializeApp);
}

app.on("before-quit", () => { void stopDaemon(); });
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
