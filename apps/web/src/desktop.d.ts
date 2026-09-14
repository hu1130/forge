export {};

declare global {
  interface Window {
    forgeDesktop?: {
      platform: string;
      isDesktop: boolean;
      cloudApiUrl: string;
      selectWorkspace: () => Promise<string | null>;
      selectSkillDirectory: () => Promise<string | null>;
      getDeepSeekStatus: () => Promise<{ configured: boolean; encryptedStorage: boolean }>;
      testDeepSeekApiKey: (apiKey?: string) => Promise<{ ok: true; latencyMs: number; modelCount: number }>;
      saveDeepSeekApiKey: (apiKey: string) => Promise<{ configured: boolean; restarted: boolean }>;
      saveMcpToken: (name: string, token: string) => Promise<{ configured: boolean; envVar: string }>;
      deleteMcpToken: (name: string) => Promise<{ configured: boolean }>;
      restartRuntime: () => Promise<{ restarted: boolean }>;
      exportDiagnostics: () => Promise<{ saved: boolean }>;
      activateCloudContext: () => Promise<{ identity: { tenantId: string; userId: string; mode: "cloud" }; restarted: boolean }>;
      activateLocalContext: () => Promise<{ identity: { tenantId: string; userId: string; mode: "local" }; restarted: boolean }>;
    };
  }
}
