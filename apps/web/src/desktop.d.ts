export interface ForgeReleaseInfo {
  version: string;
  legalVersion: string;
  publisherName: string;
  privacyContact: string;
  supportUrl: string;
  updateConfigured: boolean;
  legalAccepted: boolean;
}

export type ForgeUpdateResult =
  | { status: "unconfigured"; currentVersion: string }
  | { status: "upToDate"; currentVersion: string; checkedVersion: string }
  | { status: "available"; currentVersion: string; version: string; sha256: string; releaseNotes: string };

declare global {
  interface Window {
    forgeDesktop?: {
      platform: string;
      isDesktop: boolean;
      cloudApiUrl: string;
      selectWorkspace: () => Promise<string | null>;
      selectSkillDirectory: () => Promise<string | null>;
      getDeepSeekStatus: () => Promise<{ configured: boolean; encryptedStorage: boolean }>;
      getReleaseInfo: () => Promise<ForgeReleaseInfo>;
      acceptLegalTerms: (version: string) => Promise<ForgeReleaseInfo>;
      checkForUpdates: () => Promise<ForgeUpdateResult>;
      openAvailableUpdate: () => Promise<{ opened: boolean }>;
      openThirdPartyLicenses: () => Promise<{ opened: boolean }>;
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
