const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("forgeDesktop", {
  platform: process.platform,
  isDesktop: true,
  cloudApiUrl: process.env.FORGE_CLOUD_API_URL?.trim() || "",
  selectWorkspace: () => ipcRenderer.invoke("forge:select-workspace"),
  selectSkillDirectory: () => ipcRenderer.invoke("forge:select-skill-directory"),
  getDeepSeekStatus: () => ipcRenderer.invoke("forge:deepseek-status"),
  testDeepSeekApiKey: (apiKey) => ipcRenderer.invoke("forge:test-deepseek-key", apiKey),
  saveDeepSeekApiKey: (apiKey) => ipcRenderer.invoke("forge:save-deepseek-key", apiKey),
  saveMcpToken: (name, token) => ipcRenderer.invoke("forge:save-mcp-token", name, token),
  deleteMcpToken: (name) => ipcRenderer.invoke("forge:delete-mcp-token", name),
  restartRuntime: () => ipcRenderer.invoke("forge:restart-runtime"),
});
