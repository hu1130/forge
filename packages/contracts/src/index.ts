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
  tenantId: "local";
  userId: "local";
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
  updatedAt: string;
}

export interface QueuedTurn {
  id: string;
  clientUserMessageId: string;
  providerId: "demo" | "deepseek";
  text: string;
  contextFiles: WorkspaceFileInfo[];
  createdAt: string;
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
  name: string;
  description: string;
  scope: SkillScope;
  workspacePath?: string;
  sourcePath: string;
  enabled: boolean;
  installedAt: string;
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
