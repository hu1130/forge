export type RuntimePhase = "starting" | "ready" | "unavailable" | "error";

export interface RuntimeStatus {
  daemon: "ready";
  appServer: RuntimePhase;
  appServerVersion?: string;
  detail?: string;
}

export interface WorkspaceFileInfo {
  path: string;
  name: string;
  size: number;
}

export interface WorkspaceFilesPayload {
  files: WorkspaceFileInfo[];
  truncated: boolean;
}

export type Activity =
  | {
      id: string;
      kind: "message";
      role: "user" | "assistant";
      text: string;
      contextFiles?: WorkspaceFileInfo[];
      delivery?: "turn" | "steer";
      at: string;
    }
  | {
      id: string;
      kind: "command";
      command: string;
      description: string;
      status: "running" | "passed" | "failed";
      output?: string;
      duration?: string;
      at: string;
    }
  | {
      id: string;
      kind: "files";
      turnId?: string;
      files: Array<{ path: string; additions: number; deletions: number; diff?: string }>;
      revertedAt?: string;
      at: string;
    }
  | {
      id: string;
      kind: "tool";
      server: string;
      tool: string;
      status: "running" | "passed" | "failed";
      input?: string;
      output?: string;
      duration?: string;
      at: string;
    }
  | { id: string; kind: "notice"; tone: "info" | "success" | "warning"; text: string; at: string };

export interface ForgeTask {
  id: string;
  tenantId: string;
  userId: string;
  title: string;
  subtitle: string;
  workspacePath?: string;
  pinned?: boolean;
  archived?: boolean;
  state: "idle" | "running" | "completed" | "stopped" | "failed";
  activities: Activity[];
  queuedTurns?: QueuedTurn[];
  agentSession?: {
    providerId: string;
    model: string;
    threadId: string;
    cwd: string;
    updatedAt: string;
  };
  importedFrom?: { profile: "local"; taskId: string; importedAt: string };
  updatedAt: string;
}

export interface LocalProfileSummary {
  available: boolean;
  totalTasks: number;
  eligibleTasks: number;
  alreadyImported: number;
}

export interface LocalProfileImportResult {
  imported: number;
  skipped: number;
  tasks: ForgeTask[];
  summary: LocalProfileSummary;
}

export interface TaskSyncReceipt {
  resourceVersion: number;
  taskUpdatedAt: string;
}

export interface TaskSyncSnapshot {
  tasks: ForgeTask[];
  receipts: Record<string, TaskSyncReceipt>;
}

export interface CloudTaskMetadata {
  title: string;
  pinned: boolean;
  archived: boolean;
  updatedAt: string;
}

export interface CloudSkillCatalogMetadata {
  marketplaceId: string;
  marketplaceVersion: string;
  scope: SkillScope;
  enabled: boolean;
  updatedAt: string;
}

export interface CloudMcpCatalogMetadata {
  marketplaceId: string;
  marketplaceVersion: string;
  transport: McpTransport;
  enabled: boolean;
  approvalMode: McpApprovalMode;
  updatedAt: string;
}

export type ExtensionCatalogMetadata = CloudSkillCatalogMetadata | CloudMcpCatalogMetadata;

export interface ExtensionCatalogEntry {
  kind: "skill" | "mcp";
  key: string;
  label: string;
  metadata: ExtensionCatalogMetadata;
}

export interface ExtensionSyncReceipt {
  resourceVersion: number;
  localUpdatedAt: string;
}

export interface ExtensionSyncSnapshot {
  entries: ExtensionCatalogEntry[];
  receipts: Record<string, ExtensionSyncReceipt>;
  excluded: {
    customSkills: number;
    customMcpServers: number;
  };
}

export interface QueuedTurn {
  id: string;
  clientUserMessageId: string;
  providerId: "demo" | "deepseek";
  text: string;
  contextFiles: WorkspaceFileInfo[];
  createdAt: string;
}

export interface CloudAuthUser {
  id: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
}

export interface CloudSessionInfo {
  id: string;
  current: boolean;
  createdAt: string;
  expiresAt: string;
}

export interface CloudSessionListPayload {
  sessions: CloudSessionInfo[];
}

export interface CloudTenantContext {
  id: string;
  name: string;
  slug: string;
  kind: "personal" | "team";
  role: "owner" | "admin" | "member";
}

export interface CloudTenantListPayload {
  tenants: CloudTenantContext[];
}

export interface CloudTenantMember {
  userId: string;
  email: string;
  displayName: string;
  role: "owner" | "admin" | "member";
  joinedAt: string;
}

export interface CloudTenantInvitation {
  id: string;
  email: string;
  role: "admin" | "member";
  invitedByName: string;
  createdAt: string;
  expiresAt: string;
}

export interface CloudPendingInvitation extends CloudTenantInvitation {
  tenant: Pick<CloudTenantContext, "id" | "name" | "slug" | "kind">;
}

export interface CloudTeamOverview {
  tenant: CloudTenantContext;
  members: CloudTenantMember[];
  invitations: CloudTenantInvitation[];
}

export interface CloudPendingInvitationsPayload {
  invitations: CloudPendingInvitation[];
}

export interface ForgeIdentityContext {
  tenantId: string;
  userId: string;
  mode: "local" | "cloud";
}

export type CloudAuthSession =
  | { authenticated: false }
  | {
      authenticated: true;
      sessionId: string;
      user: CloudAuthUser;
      tenant: CloudTenantContext;
      csrfToken: string;
      expiresAt: string;
    };

export type CloudTenantResourceKind = "project" | "task" | "skill" | "mcp";

export interface CloudTenantResource {
  kind: CloudTenantResourceKind;
  key: string;
  ownerUserId: string;
  updatedByUserId: string;
  payload: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CloudTenantResourcesPayload {
  tenantId: string;
  resources: CloudTenantResource[];
}

export interface ProviderOption {
  id: string;
  label: string;
  model: string;
  mode: "demo" | "provider";
  configured: boolean;
}

export interface GitFileStatus {
  path: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
}

export interface GitBranchInfo {
  name: string;
  current: boolean;
}

export interface GitCommitInfo {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  authoredAt: string;
}

export interface GitStatus {
  available: boolean;
  isRepository: boolean;
  branch: string;
  head?: string;
  ahead: number;
  behind: number;
  changes: GitFileStatus[];
  branches: GitBranchInfo[];
  commits: GitCommitInfo[];
  message?: string;
}

export interface ApprovalRequest {
  id: string;
  taskId: string;
  kind: "command" | "files" | "mcp";
  command?: string;
  cwd?: string;
  reason?: string;
  server?: string;
  tool?: string;
  toolInput?: string;
  requestedAt: string;
  availableDecisions: Array<"accept" | "acceptForSession" | "decline">;
}

export interface TerminalSession {
  id: string;
  title: string;
  cwd: string;
  shell: string;
  status: "running" | "exited";
  createdAt: string;
  exitCode?: number;
}

export type SkillScope = "global" | "project";

export interface SkillInfo {
  id: string;
  tenantId: string;
  userId: string;
  name: string;
  description: string;
  scope: SkillScope;
  workspacePath?: string;
  sourcePath: string;
  enabled: boolean;
  installedAt: string;
  updatedAt: string;
  marketplaceId?: string;
  marketplaceVersion?: string;
  status: "ready" | "disabled" | "error";
  error?: string;
}

export type McpTransport = "stdio" | "http";
export type McpApprovalMode = "auto" | "prompt" | "writes";
export type McpConnectionStatus = "notStarted" | "starting" | "connected" | "authenticationRequired" | "failed" | "cancelled" | "disabled" | "unavailable";

export interface McpServerInfo {
  name: string;
  tenantId: string;
  userId: string;
  transport: McpTransport;
  command?: string;
  args: string[];
  envVars: string[];
  url?: string;
  enabled: boolean;
  approvalMode: McpApprovalMode;
  useBearerToken: boolean;
  tokenConfigured: boolean;
  status: McpConnectionStatus;
  tools: Array<{ name: string; title?: string; description?: string }>;
  createdAt: string;
  updatedAt: string;
  marketplaceId?: string;
  marketplaceVersion?: string;
}

export interface ExtensionPayload {
  skills: SkillInfo[];
  mcpServers: McpServerInfo[];
}

export type MarketplaceItemKind = "skill" | "mcp";
export type MarketplaceCategory = "开发" | "知识" | "数据" | "效率" | "其他";
export type MarketplaceInstallStatus = "notInstalled" | "installed" | "updateAvailable";

export interface MarketplaceItem {
  id: string;
  kind: MarketplaceItemKind;
  name: string;
  description: string;
  details: string;
  publisher: string;
  version: string;
  category: MarketplaceCategory;
  tags: string[];
  featured: boolean;
  homepage?: string;
  verified: boolean;
  mcp?: {
    name: string;
    transport: McpTransport;
    command?: string;
    args: string[];
    envVars: string[];
    url?: string;
    approvalMode: McpApprovalMode;
    useBearerToken: boolean;
    bearerTokenRequired: boolean;
  };
  installation: {
    status: MarketplaceInstallStatus;
    installedVersion?: string;
    installedId?: string;
    installedName?: string;
  };
}

export interface MarketplacePayload {
  source: {
    kind: "remote" | "cache" | "builtIn";
    label: string;
    url?: string;
    refreshedAt: string;
    warning?: string;
  };
  items: MarketplaceItem[];
}

export type TerminalStreamEvent =
  | { type: "data"; data: string }
  | { type: "exit"; exitCode: number };

export interface BootstrapPayload {
  identity: ForgeIdentityContext;
  workspace: { name: string; branch: string; path: string };
  git: GitStatus;
  runtime: RuntimeStatus;
  tasks: ForgeTask[];
  providers: ProviderOption[];
  approvals: ApprovalRequest[];
}

export type TaskStreamEvent =
  | { type: "turn"; turnId: string; state: "started" | "completed" | "stopped" | "failed" }
  | { type: "activity"; activity: Activity }
  | { type: "queue"; items: QueuedTurn[] }
  | { type: "approval"; approval: ApprovalRequest }
  | { type: "approvalResolved"; approvalId: string; decision: "accept" | "acceptForSession" | "decline" }
  | { type: "runtime"; runtime: RuntimeStatus }
  | { type: "error"; message: string };
