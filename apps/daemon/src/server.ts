import { randomUUID, timingSafeEqual } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import cors from "@fastify/cors";
import staticPlugin from "@fastify/static";
import Fastify, { type FastifyReply } from "fastify";
import type {
  Activity, ApprovalRequest, BootstrapPayload, CloudMcpCatalogMetadata, CloudSkillCatalogMetadata,
  CloudTaskMetadata, EncryptedTaskBackupEnvelope, ExtensionPayload, ExtensionSyncSnapshot, ForgeIdentityContext, ForgeTask, MarketplacePayload,
  McpConnectionStatus, McpServerInfo, ProviderOption, QueuedTurn, RuntimeStatus, SkillInfo,
  SkillScope, TaskStreamEvent, WorkspaceFileInfo, WorkspacePreferences,
} from "@forge/contracts";
import { applyTaskChanges, type ChangeAction } from "./change-manager.js";
import { CodexBridge, type RpcMessage } from "./codex-bridge.js";
import { deepSeekAppServerArgs, deepSeekSettings } from "./deepseek.js";
import { ExtensionStore, mcpAppServerArgs } from "./extension-store.js";
import { commitStagedChanges, createGitBranch, getGitStatus, switchGitBranch, updateGitIndex, type GitIndexAction } from "./git-manager.js";
import { MarketplaceStore } from "./marketplace.js";
import { TaskStore } from "./task-store.js";
import { TerminalManager } from "./terminal-manager.js";
import { turnDiffActivity } from "./unified-diff.js";
import { buildContextPrompt, searchWorkspaceFiles, validateContextFiles } from "./workspace-files.js";

const host = process.env.FORGE_HOST || "127.0.0.1";
const port = Number(process.env.FORGE_PORT || 4782);
const apiToken = process.env.FORGE_API_TOKEN?.trim() || "";
const defaultWorkspacePath = path.resolve(process.env.FORGE_WORKSPACE || process.cwd());
const configuredTenantId = process.env.FORGE_TENANT_ID?.trim() || "";
const configuredUserId = process.env.FORGE_USER_ID?.trim() || "";
if (Boolean(configuredTenantId) !== Boolean(configuredUserId)) throw new Error("Forge 租户和用户上下文必须同时提供");
const cloudIdentityPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
if (configuredTenantId && (!cloudIdentityPattern.test(configuredTenantId) || !cloudIdentityPattern.test(configuredUserId))) {
  throw new Error("Forge 云端身份格式无效");
}
const identity: ForgeIdentityContext = configuredTenantId
  ? { tenantId: configuredTenantId, userId: configuredUserId, mode: "cloud" }
  : { tenantId: "local", userId: "local", mode: "local" };
const deepSeek = deepSeekSettings();
const extensions = new ExtensionStore(identity);
await extensions.load();
const marketplace = new MarketplaceStore();
await marketplace.load();
if (process.env.FORGE_MARKETPLACE_URL?.trim()) void marketplace.refresh().catch(() => undefined);
const runtimeArgs = () => [
  "-c", "shell_environment_policy.ignore_default_excludes=false",
  "-c", 'shell_environment_policy.exclude=["FORGE_MCP_TOKEN_*"]',
  ...(deepSeek.configured ? deepSeekAppServerArgs(deepSeek) : []),
  ...mcpAppServerArgs(extensions.mcpConfigs()),
];
const bridge = new CodexBridge(runtimeArgs());
const store = new TaskStore(defaultWorkspacePath, identity);
await store.load();
let workspacePath = store.workspace();
const terminals = new TerminalManager(workspacePath);

interface RunningTurn {
  stopped: boolean;
  turnId: string;
  providerId: "demo" | "deepseek";
  threadId?: string;
  steerReady?: boolean;
  emit: (event: TaskStreamEvent) => void;
  interrupt?: () => Promise<void>;
}

interface PendingApproval extends ApprovalRequest {
  rpcRequestId: number | string;
  responseType: "decision" | "mcp";
  respond: (event: TaskStreamEvent) => void;
}

interface AppServerThreadStart {
  thread?: { id?: string };
}

interface AppServerTurnStart {
  turn?: { id?: string };
}

interface AppServerQueueAdd {
  queuedSubmission?: { id?: string; clientUserMessageId?: string };
}

type JsonRecord = Record<string, unknown>;

const runningTurns = new Map<string, RunningTurn>();
const pendingApprovals = new Map<string, PendingApproval>();
const MAX_QUEUED_TURNS = 20;
const now = () => new Date().toISOString();
const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null;

function authorizedApiToken(authorization?: string, cookieHeader?: string) {
  if (!apiToken) return true;
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  const cookie = cookieHeader?.split(";").map((value) => value.trim()).find((value) => value.startsWith("forge_session="))?.slice("forge_session=".length) || "";
  const candidate = bearer || cookie;
  const expectedBuffer = Buffer.from(apiToken);
  const candidateBuffer = Buffer.from(candidate);
  return expectedBuffer.length === candidateBuffer.length && timingSafeEqual(expectedBuffer, candidateBuffer);
}

async function applySkillRoots() {
  await bridge.start();
  await bridge.request("skills/extraRoots/set", { extraRoots: extensions.enabledSkillRoots(workspacePath) }, 20_000);
}

async function startRuntime() {
  await bridge.start();
  await applySkillRoots();
}

async function restartRuntime() {
  await bridge.restart(runtimeArgs());
  await applySkillRoots();
}

async function loadedDeepSeekThread(task: ForgeTask) {
  const running = runningTurns.get(task.id);
  if (running?.providerId === "deepseek") {
    if (!running.threadId) throw new Error("模型会话正在启动，请稍候再操作队列");
    return running.threadId;
  }
  const session = task.agentSession;
  const taskWorkspacePath = task.workspacePath || workspacePath;
  if (!session || session.providerId !== "deepseek") throw new Error("这个任务还没有可恢复的 DeepSeek 会话");
  if (session.model !== deepSeek.model || session.cwd !== taskWorkspacePath) {
    throw new Error("当前任务绑定的模型或工作区已经改变，Forge 未自动迁移队列");
  }
  await startRuntime();
  const resumed = await bridge.request("thread/resume", {
    threadId: session.threadId,
    model: deepSeek.model,
    modelProvider: "deepseek",
    cwd: taskWorkspacePath,
    approvalPolicy: store.preferences().approvalPolicy,
    approvalsReviewer: "user",
    sandbox: "workspace-write",
    excludeTurns: true,
  }, 20_000) as AppServerThreadStart;
  return resumed.thread?.id || session.threadId;
}

function normalizedFilePath(value: string) {
  return path.resolve(value).replaceAll("\\", "/").toLocaleLowerCase();
}

async function extensionPayload(): Promise<ExtensionPayload> {
  let skills = extensions.listSkills(workspacePath);
  let mcpServers = extensions.listMcpServers();
  try {
    await startRuntime();
    const [skillsResponse, mcpResponse] = await Promise.all([
      bridge.request("skills/list", { cwds: [workspacePath], forceReload: true }, 20_000),
      bridge.request("mcpServerStatus/list", { detail: "full", limit: 100 }, 20_000),
    ]);

    const listedSkillPaths = new Set<string>();
    const skillErrors = new Map<string, string>();
    if (isRecord(skillsResponse) && Array.isArray(skillsResponse.data)) {
      for (const entry of skillsResponse.data) {
        if (!isRecord(entry)) continue;
        if (Array.isArray(entry.skills)) {
          for (const skill of entry.skills) {
            if (isRecord(skill) && typeof skill.path === "string") listedSkillPaths.add(normalizedFilePath(skill.path));
          }
        }
        if (Array.isArray(entry.errors)) {
          for (const error of entry.errors) {
            if (!isRecord(error)) continue;
            const errorPath = typeof error.path === "string" ? normalizedFilePath(error.path) : "";
            const message = typeof error.message === "string" ? error.message : "Skill 加载失败";
            if (errorPath) skillErrors.set(errorPath, message);
          }
        }
      }
    }
    const configuredPaths = extensions.skillPaths(workspacePath);
    skills = skills.map((skill): SkillInfo => {
      if (!skill.enabled) return skill;
      const skillPath = configuredPaths.get(skill.id);
      const normalized = skillPath ? normalizedFilePath(path.join(skillPath, "SKILL.md")) : "";
      const matchedError = [...skillErrors.entries()].find(([errorPath]) => normalized.startsWith(path.dirname(errorPath).replaceAll("\\", "/")))?.[1];
      if (matchedError) return { ...skill, status: "error", error: matchedError };
      if (normalized && listedSkillPaths.has(normalized)) return skill;
      return { ...skill, status: "error", error: "App Server 尚未发现此 Skill" };
    });

    const statuses = new Map<string, JsonRecord>();
    if (isRecord(mcpResponse) && Array.isArray(mcpResponse.data)) {
      for (const item of mcpResponse.data) if (isRecord(item) && typeof item.name === "string") statuses.set(item.name, item);
    }
    mcpServers = mcpServers.map((server): McpServerInfo => {
      const status = statuses.get(server.name);
      if (!status) return server;
      const tools = isRecord(status.tools) ? Object.values(status.tools).flatMap((tool) => {
        if (!isRecord(tool) || typeof tool.name !== "string") return [];
        return [{
          name: tool.name,
          title: typeof tool.title === "string" ? tool.title : undefined,
          description: typeof tool.description === "string" ? tool.description : undefined,
        }];
      }) : [];
      const runtimeState = typeof status.runtimeStatus === "string"
        ? status.runtimeStatus as McpConnectionStatus
        : tools.length > 0 && server.enabled ? "connected" : server.status;
      return { ...server, status: runtimeState, tools };
    });
  } catch {
    skills = skills.map((skill): SkillInfo => skill.enabled
      ? { ...skill, status: "error", error: "App Server 不可用，无法加载此 Skill" }
      : skill);
    mcpServers = mcpServers.map((server) => ({ ...server, status: server.enabled ? "unavailable" : "disabled" }));
  }
  return { skills, mcpServers };
}

function marketplacePayload(scope: SkillScope): MarketplacePayload {
  return marketplace.payload({
    skills: extensions.listSkills(workspacePath),
    mcpServers: extensions.listMcpServers(),
  }, scope);
}

function runtimeStatus(): RuntimeStatus {
  const status = bridge.status();
  const provider = deepSeek.configured ? `DeepSeek · ${deepSeek.model} · ` : "";
  return { daemon: "ready", appServer: status.phase, detail: `${provider}${status.detail}` };
}

function providers(): ProviderOption[] {
  return [
    { id: "demo", label: "演示", model: "本机事件流", mode: "demo", configured: true },
    { id: "deepseek", label: "DeepSeek", model: deepSeek.model, mode: "provider", configured: deepSeek.configured },
  ];
}

async function bootstrapPayload(): Promise<BootstrapPayload> {
  const git = await getGitStatus(workspacePath);
  return {
    identity: store.identityContext(),
    workspace: { name: path.basename(workspacePath), branch: git.branch, path: workspacePath },
    preferences: store.preferences(),
    git,
    runtime: runtimeStatus(),
    tasks: store.list(workspacePath),
    providers: providers(),
    approvals: [...pendingApprovals.values()].map(({ rpcRequestId: _rpcRequestId, responseType: _responseType, respond: _respond, ...approval }) => approval),
  };
}

function beginEventStream(reply: FastifyReply) {
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  return (event: TaskStreamEvent) => {
    if (!reply.raw.destroyed && !reply.raw.writableEnded) {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  };
}

function commandActivity(item: JsonRecord, outputOverride?: string): Activity | null {
  if (item.type !== "commandExecution" || typeof item.id !== "string" || typeof item.command !== "string") return null;
  const codexStatus = typeof item.status === "string" ? item.status : "inProgress";
  const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
  const status = codexStatus === "inProgress" ? "running" : codexStatus === "completed" && (exitCode === null || exitCode === 0) ? "passed" : "failed";
  const durationMs = typeof item.durationMs === "number" ? item.durationMs : null;
  const aggregatedOutput = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : undefined;
  return {
    id: item.id,
    kind: "command",
    command: item.command,
    description: status === "running" ? "正在执行" : "命令执行",
    status,
    output: outputOverride ?? aggregatedOutput,
    duration: durationMs === null ? undefined : `${(durationMs / 1000).toFixed(1)}s`,
    at: now(),
  };
}

function compactJson(value: unknown) {
  if (value === undefined || value === null) return undefined;
  let serialized: string;
  try { serialized = JSON.stringify(value, null, 2); } catch { serialized = String(value); }
  return serialized.length > 4000 ? `${serialized.slice(0, 4000)}\n…输出已截断` : serialized;
}

function toolActivity(item: JsonRecord): Activity | null {
  if (item.type !== "mcpToolCall" || typeof item.id !== "string" || typeof item.server !== "string" || typeof item.tool !== "string") return null;
  const rawStatus = typeof item.status === "string" ? item.status : "inProgress";
  const status = rawStatus === "inProgress" ? "running" : rawStatus === "completed" ? "passed" : "failed";
  const durationMs = typeof item.durationMs === "number" ? item.durationMs : null;
  const errorMessage = isRecord(item.error) && typeof item.error.message === "string" ? item.error.message : undefined;
  return {
    id: item.id,
    kind: "tool",
    server: item.server,
    tool: item.tool,
    status,
    input: compactJson(item.arguments),
    output: errorMessage || compactJson(item.result),
    duration: durationMs === null ? undefined : `${(durationMs / 1000).toFixed(1)}s`,
    at: now(),
  };
}

function turnState(status: unknown): "completed" | "stopped" | "failed" {
  if (status === "interrupted") return "stopped";
  if (status === "failed") return "failed";
  return "completed";
}

function deepSeekErrorMessage(message: string) {
  if (/401|authentication fails/i.test(message)) return "DeepSeek API Key 无效或已失效，请检查 DEEPSEEK_API_KEY。";
  if (/402|insufficient balance/i.test(message)) return "DeepSeek 账户余额不足，请充值后重试。";
  if (/429|rate limit/i.test(message)) return "DeepSeek 请求过于频繁，请稍后重试。";
  return message.replace(/(api key:)\s*[^,\s]+/gi, "$1 ****");
}

function approvalFromRequest(taskId: string, message: RpcMessage, respond: PendingApproval["respond"]): PendingApproval | null {
  if (message.id === undefined || !isRecord(message.params)) return null;
  const params = message.params;
  if (message.method === "item/commandExecution/requestApproval") {
    const requestedDecisions: ApprovalRequest["availableDecisions"] = Array.isArray(params.availableDecisions)
      ? params.availableDecisions.filter((decision): decision is "accept" | "acceptForSession" | "decline" => decision === "accept" || decision === "acceptForSession" || decision === "decline")
      : ["accept", "acceptForSession", "decline"];
    const availableDecisions: ApprovalRequest["availableDecisions"] = requestedDecisions.includes("decline")
      ? requestedDecisions
      : [...requestedDecisions, "decline"];
    return {
      id: randomUUID(),
      taskId,
      kind: "command",
      command: typeof params.command === "string" ? params.command : undefined,
      cwd: typeof params.cwd === "string" ? params.cwd : undefined,
      reason: typeof params.reason === "string" ? params.reason : undefined,
      requestedAt: now(),
      availableDecisions,
      rpcRequestId: message.id,
      responseType: "decision",
      respond,
    };
  }
  if (message.method === "item/fileChange/requestApproval") {
    return {
      id: randomUUID(),
      taskId,
      kind: "files",
      cwd: typeof params.grantRoot === "string" ? params.grantRoot : undefined,
      reason: typeof params.reason === "string" ? params.reason : undefined,
      requestedAt: now(),
      availableDecisions: ["accept", "acceptForSession", "decline"],
      rpcRequestId: message.id,
      responseType: "decision",
      respond,
    };
  }
  if (
    message.method === "mcpServer/elicitation/request"
    && params.mode === "form"
    && isRecord(params._meta)
    && params._meta.codex_approval_kind === "mcp_tool_call"
  ) {
    const persistence = params._meta.persist;
    const supportsSession = persistence === "session"
      || (Array.isArray(persistence) && persistence.includes("session"));
    const toolName = typeof params._meta.tool_name === "string" ? params._meta.tool_name : "MCP 工具";
    const toolTitle = typeof params._meta.tool_title === "string" ? params._meta.tool_title : toolName;
    return {
      id: randomUUID(),
      taskId,
      kind: "mcp",
      server: typeof params.serverName === "string" ? params.serverName : "MCP",
      tool: toolTitle,
      toolInput: compactJson(params._meta.tool_params),
      reason: typeof params.message === "string" ? params.message : "Agent 请求调用 MCP 工具。",
      requestedAt: now(),
      availableDecisions: supportsSession ? ["accept", "acceptForSession", "decline"] : ["accept", "decline"],
      rpcRequestId: message.id,
      responseType: "mcp",
      respond,
    };
  }
  return null;
}

function cancelTaskApprovals(taskId: string) {
  for (const approval of [...pendingApprovals.values()]) {
    if (approval.taskId !== taskId) continue;
    bridge.respond(approval.rpcRequestId, approval.responseType === "mcp"
      ? { action: "cancel", content: null, _meta: null }
      : { decision: "cancel" });
    approval.respond({ type: "approvalResolved", approvalId: approval.id, decision: "decline" });
    pendingApprovals.delete(approval.id);
  }
}

function queuedUserActivity(queuedTurn: QueuedTurn): Activity {
  return {
    id: queuedTurn.clientUserMessageId,
    kind: "message",
    role: "user",
    text: queuedTurn.text,
    contextFiles: queuedTurn.contextFiles,
    delivery: "turn",
    at: now(),
  };
}

function demoActivities(): Activity[] {
  const commandId = randomUUID();
  return [
    {
      id: randomUUID(),
      kind: "message",
      role: "assistant",
      text: "收到。我会先检查目标和当前工作区，再给出可验证的执行结果。当前为显式演示事件流，不会调用或降级到任何真实模型。",
      at: now(),
    },
    {
      id: commandId,
      kind: "command",
      command: "git status --short",
      description: "检查工作区状态",
      status: "running",
      at: now(),
    },
    {
      id: commandId,
      kind: "command",
      command: "git status --short",
      description: "检查工作区状态",
      status: "passed",
      output: "工作区状态已读取",
      duration: "0.4s",
      at: now(),
    },
    {
      id: randomUUID(),
      kind: "notice",
      tone: "success",
      text: "前后端流式通道工作正常。DeepSeek 已接入真实 App Server 任务流。",
      at: now(),
    },
  ];
}

async function runDemoTurn(taskId: string, userActivity: Activity | undefined, reply: FastifyReply, initialQueue?: QueuedTurn[]) {
  const send = beginEventStream(reply);
  const controller: RunningTurn = { stopped: false, turnId: randomUUID(), providerId: "demo", emit: send };
  runningTurns.set(taskId, controller);
  const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  if (initialQueue) send({ type: "queue", items: initialQueue });

  try {
    let nextActivity = userActivity;
    while (nextActivity) {
      controller.turnId = randomUUID();
      await store.setState(taskId, "running");
      send({ type: "turn", turnId: controller.turnId, state: "started" });
      send({ type: "activity", activity: nextActivity });

      for (const activity of demoActivities()) {
        await delay(520);
        if (controller.stopped) break;
        await store.addActivity(taskId, activity);
        send({ type: "activity", activity });
      }
      const state = controller.stopped ? "stopped" : "completed";
      send({ type: "turn", turnId: controller.turnId, state });
      if (controller.stopped) {
        await store.setState(taskId, "stopped");
        break;
      }

      const queuedTurn = store.find(taskId)?.queuedTurns?.[0];
      if (!queuedTurn) {
        await store.setState(taskId, "completed");
        break;
      }
      if (queuedTurn.providerId !== "demo") throw new Error("演示队列包含不兼容的模型任务，Forge 未自动切换提供商");
      const queue = await store.removeQueuedTurn(taskId, queuedTurn.id) || [];
      send({ type: "queue", items: queue });
      nextActivity = queuedUserActivity(queuedTurn);
      await store.addActivity(taskId, nextActivity);
    }
  } finally {
    runningTurns.delete(taskId);
    reply.raw.end();
  }
}

type CompletedTurnState = "completed" | "stopped" | "failed";

function turnCompletion() {
  let resolve!: (state: CompletedTurnState) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<CompletedTurnState>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject, settled: false };
}

async function runDeepSeekTurn(
  task: ForgeTask,
  text: string | undefined,
  userActivity: Activity | undefined,
  reply: FastifyReply,
  initialQueuedTurn?: QueuedTurn,
) {
  const taskId = task.id;
  const taskWorkspacePath = task.workspacePath || workspacePath;
  const send = beginEventStream(reply);
  const controller: RunningTurn = { stopped: false, turnId: randomUUID(), providerId: "deepseek", emit: send };
  runningTurns.set(taskId, controller);
  if (userActivity) send({ type: "activity", activity: userActivity });

  let threadId = "";
  let notificationQueue = Promise.resolve();
  let completion = turnCompletion();
  const assistantText = new Map<string, string>();
  const persistedAssistantIds = new Set<string>();
  const commandOutput = new Map<string, string>();
  const nativeStartedTurnIds = new Set<string>();
  let lastErrorMessage = "";

  const finish = (stateOrError: CompletedTurnState | Error) => {
    if (completion.settled) return;
    completion.settled = true;
    if (stateOrError instanceof Error) completion.reject(stateOrError);
    else completion.resolve(stateOrError);
  };

  const handleNotification = async (message: RpcMessage) => {
    if (!message.method || !isRecord(message.params)) return;
    const params = message.params;
    if (params.threadId !== threadId) return;

    if (message.method === "turn/started" && isRecord(params.turn) && typeof params.turn.id === "string") {
      nativeStartedTurnIds.add(params.turn.id);
      if (params.turn.id === controller.turnId) controller.steerReady = true;
      return;
    }

    if (message.method === "turn/diff/updated" && typeof params.turnId === "string" && typeof params.diff === "string") {
      const activity = turnDiffActivity(params.turnId, params.diff);
      if (activity) {
        await store.addActivity(taskId, activity);
        send({ type: "activity", activity });
      }
      return;
    }

    if (message.method === "item/agentMessage/delta" && typeof params.itemId === "string" && typeof params.delta === "string") {
      const accumulated = `${assistantText.get(params.itemId) || ""}${params.delta}`;
      assistantText.set(params.itemId, accumulated);
      send({ type: "activity", activity: { id: params.itemId, kind: "message", role: "assistant", text: accumulated, at: now() } });
      return;
    }

    if ((message.method === "item/started" || message.method === "item/completed") && isRecord(params.item)) {
      const item = params.item;
      if (item.type === "agentMessage" && typeof item.id === "string" && typeof item.text === "string" && message.method === "item/completed") {
        assistantText.set(item.id, item.text);
        persistedAssistantIds.add(item.id);
        const activity: Activity = { id: item.id, kind: "message", role: "assistant", text: item.text, at: now() };
        await store.addActivity(taskId, activity);
        send({ type: "activity", activity });
        return;
      }

      const command = commandActivity(item, commandOutput.get(typeof item.id === "string" ? item.id : ""));
      if (command) {
        await store.addActivity(taskId, command);
        send({ type: "activity", activity: command });
        return;
      }

      const tool = toolActivity(item);
      if (tool) {
        await store.addActivity(taskId, tool);
        send({ type: "activity", activity: tool });
        return;
      }

      return;
    }

    if (message.method === "item/commandExecution/outputDelta" && typeof params.itemId === "string" && typeof params.delta === "string") {
      commandOutput.set(params.itemId, `${commandOutput.get(params.itemId) || ""}${params.delta}`);
      return;
    }

    if (message.method === "error" && params.willRetry === false && isRecord(params.error) && typeof params.error.message === "string") {
      lastErrorMessage = deepSeekErrorMessage(params.error.message);
      send({ type: "error", message: lastErrorMessage });
      return;
    }

    if (message.method === "turn/completed" && isRecord(params.turn)) {
      controller.steerReady = false;
      for (const [itemId, accumulated] of assistantText) {
        if (!accumulated || persistedAssistantIds.has(itemId)) continue;
        await store.addActivity(taskId, { id: itemId, kind: "message", role: "assistant", text: accumulated, at: now() });
      }
      const state = controller.stopped ? "stopped" : turnState(params.turn.status);
      if (state === "failed") {
        const rawMessage = isRecord(params.turn.error) && typeof params.turn.error.message === "string"
          ? params.turn.error.message
          : lastErrorMessage || "DeepSeek 任务执行失败。";
        const message = deepSeekErrorMessage(rawMessage);
        const notice: Activity = { id: randomUUID(), kind: "notice", tone: "warning", text: message, at: now() };
        await store.addActivity(taskId, notice);
        send({ type: "activity", activity: notice });
        if (message !== lastErrorMessage) send({ type: "error", message });
      }
      finish(state);
    }
  };

  const onNotification = (message: RpcMessage) => {
    notificationQueue = notificationQueue.then(() => handleNotification(message)).catch((error) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });
  };
  const onRequest = (message: RpcMessage) => {
    if (message.id === undefined || !isRecord(message.params) || message.params.threadId !== threadId) return;
    const approval = approvalFromRequest(taskId, message, send);
    if (approval) {
      pendingApprovals.set(approval.id, approval);
      const { rpcRequestId: _rpcRequestId, responseType: _responseType, respond: _respond, ...publicApproval } = approval;
      send({ type: "approval", approval: publicApproval });
    } else if (message.method === "mcpServer/elicitation/request") {
      bridge.respond(message.id, { action: "cancel", content: null, _meta: null });
      const notice: Activity = {
        id: randomUUID(),
        kind: "notice",
        tone: "warning",
        text: "MCP 服务请求了当前版本尚不支持的结构化输入，本次请求已取消。",
        at: now(),
      };
      void store.addActivity(taskId, notice);
      send({ type: "activity", activity: notice });
    }
  };
  const onStatus = (status: { phase?: string; detail?: string }) => {
    if (status.phase === "unavailable") finish(new Error(status.detail || "DeepSeek App Server 不可用"));
  };

  bridge.on("notification", onNotification);
  bridge.on("request", onRequest);
  bridge.on("status", onStatus);

  try {
    await startRuntime();
    const existingSession = task.agentSession;
    if (existingSession) {
      if (
        existingSession.providerId !== "deepseek"
        || existingSession.model !== deepSeek.model
        || existingSession.cwd !== taskWorkspacePath
      ) {
        throw new Error("当前任务绑定的模型或工作区已经改变，请新建任务后继续。为避免丢失上下文，Forge 未自动创建新会话。");
      }
      const resumed = await bridge.request("thread/resume", {
        threadId: existingSession.threadId,
        model: deepSeek.model,
        modelProvider: "deepseek",
        cwd: taskWorkspacePath,
        approvalPolicy: store.preferences().approvalPolicy,
        approvalsReviewer: "user",
        sandbox: "workspace-write",
        excludeTurns: true,
      }, 20_000) as AppServerThreadStart;
      threadId = resumed.thread?.id || existingSession.threadId;
    } else {
      const started = await bridge.request("thread/start", {
        model: deepSeek.model,
        modelProvider: "deepseek",
        allowProviderModelFallback: false,
        cwd: taskWorkspacePath,
        approvalPolicy: store.preferences().approvalPolicy,
        approvalsReviewer: "user",
        sandbox: "workspace-write",
        ephemeral: false,
      }, 20_000) as AppServerThreadStart;
      threadId = started.thread?.id || "";
      if (threadId) {
        await store.setAgentSession(taskId, {
          providerId: "deepseek",
          model: deepSeek.model,
          threadId,
          cwd: taskWorkspacePath,
          updatedAt: now(),
        });
      }
    }
    if (!threadId) throw new Error("DeepSeek App Server 未返回 threadId");
    controller.threadId = threadId;

    if (controller.stopped) {
      await store.setState(taskId, "stopped");
      send({ type: "turn", turnId: controller.turnId, state: "stopped" });
      return;
    }

    let turnStart: AppServerTurnStart;
    if (initialQueuedTurn) {
      turnStart = await bridge.request("thread/queue/start", {
        threadId,
        queuedSubmissionId: initialQueuedTurn.id,
      }, 20_000) as AppServerTurnStart;
      const queue = await store.removeQueuedTurn(taskId, initialQueuedTurn.id) || [];
      const activity = queuedUserActivity(initialQueuedTurn);
      await store.addActivity(taskId, activity);
      send({ type: "queue", items: queue });
      send({ type: "activity", activity });
    } else {
      if (!text) throw new Error("缺少要执行的任务内容");
      turnStart = await bridge.request("turn/start", {
        threadId,
        input: [{ type: "text", text, text_elements: [] }],
        cwd: taskWorkspacePath,
        approvalPolicy: store.preferences().approvalPolicy,
        approvalsReviewer: "user",
      }) as AppServerTurnStart;
    }
    controller.turnId = turnStart.turn?.id || controller.turnId;
    controller.steerReady = nativeStartedTurnIds.has(controller.turnId);
    controller.interrupt = async () => {
      await bridge.request("turn/interrupt", { threadId, turnId: controller.turnId });
    };
    send({ type: "turn", turnId: controller.turnId, state: "started" });

    while (true) {
      if (controller.stopped) await controller.interrupt();
      const state = await completion.promise;
      await notificationQueue;
      send({ type: "turn", turnId: controller.turnId, state });
      if (controller.stopped || state !== "completed") {
        await store.setState(taskId, controller.stopped ? "stopped" : state);
        break;
      }

      const queuedTurn = store.find(taskId)?.queuedTurns?.[0];
      if (!queuedTurn) {
        await store.setState(taskId, "completed");
        break;
      }
      if (queuedTurn.providerId !== "deepseek") throw new Error("DeepSeek 队列包含不兼容的模型任务，Forge 未自动切换提供商");

      completion = turnCompletion();
      lastErrorMessage = "";
      const queuedStart = await bridge.request("thread/queue/start", {
        threadId,
        queuedSubmissionId: queuedTurn.id,
      }, 20_000) as AppServerTurnStart;
      controller.turnId = queuedStart.turn?.id || randomUUID();
      controller.steerReady = nativeStartedTurnIds.has(controller.turnId);
      const queue = await store.removeQueuedTurn(taskId, queuedTurn.id) || [];
      const activity = queuedUserActivity(queuedTurn);
      await store.addActivity(taskId, activity);
      send({ type: "queue", items: queue });
      send({ type: "activity", activity });
      send({ type: "turn", turnId: controller.turnId, state: "started" });
    }
  } catch (reason) {
    const rawMessage = reason instanceof Error ? reason.message : String(reason);
    const error = new Error(deepSeekErrorMessage(rawMessage));
    const state = controller.stopped ? "stopped" : "failed";
    await store.setState(taskId, state);
    if (state === "failed") {
      const notice: Activity = { id: randomUUID(), kind: "notice", tone: "warning", text: error.message, at: now() };
      await store.addActivity(taskId, notice);
      send({ type: "activity", activity: notice });
      send({ type: "error", message: error.message });
    }
    send({ type: "turn", turnId: controller.turnId, state });
  } finally {
    bridge.off("notification", onNotification);
    bridge.off("request", onRequest);
    bridge.off("status", onStatus);
    if (runningTurns.get(taskId) === controller) runningTurns.delete(taskId);
    cancelTaskApprovals(taskId);
    if (!reply.raw.writableEnded) reply.raw.end();
  }
}

const app = Fastify({ logger: false });
await app.register(cors, { origin: [/^http:\/\/127\.0\.0\.1(?::\d+)?$/, /^http:\/\/localhost(?::\d+)?$/] });
app.addHook("onRequest", async (request, reply) => {
  if (!request.url.startsWith("/api/") || authorizedApiToken(request.headers.authorization, request.headers.cookie)) return;
  return reply.code(401).send({ message: "Forge 本机会话无效，请重新启动应用" });
});

app.get("/api/health", async () => runtimeStatus());

app.get("/api/session", async () => ({ protected: Boolean(apiToken) }));

app.get("/api/bootstrap", async (): Promise<BootstrapPayload> => bootstrapPayload());

app.post<{ Body: { path?: string } }>("/api/workspace", async (request, reply) => {
  const requestedPath = request.body?.path?.trim();
  if (!requestedPath || !path.isAbsolute(requestedPath)) return reply.code(400).send({ message: "请选择有效的绝对文件夹路径" });
  if (runningTurns.size > 0) return reply.code(409).send({ message: "请先停止正在运行的任务，再切换项目" });
  const resolved = path.resolve(requestedPath);
  try {
    const info = await stat(resolved);
    if (!info.isDirectory()) return reply.code(400).send({ message: "选择的路径不是文件夹" });
  } catch {
    return reply.code(400).send({ message: "选择的文件夹不存在或无法访问" });
  }
  workspacePath = resolved;
  await store.setWorkspace(resolved);
  terminals.setWorkspaceRoot(resolved);
  await applySkillRoots().catch(() => undefined);
  return bootstrapPayload();
});

app.patch<{ Body: Partial<WorkspacePreferences> }>("/api/preferences", async (request, reply) => {
  if (runningTurns.size) return reply.code(409).send({ message: "请先停止正在运行的任务，再修改工作区默认配置" });
  try {
    return await store.updatePreferences(request.body || {});
  } catch (error) {
    return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
  }
});

app.get<{ Querystring: { query?: string } }>("/api/workspace/files", async (request, reply) => {
  try {
    return await searchWorkspaceFiles(workspacePath, request.query?.query || "");
  } catch (error) {
    return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/git/status", async () => getGitStatus(workspacePath));

app.post<{ Body: { name?: string } }>("/api/git/branches", async (request, reply) => {
  if (runningTurns.size) return reply.code(409).send({ message: "请先停止正在运行的任务，再创建分支" });
  try {
    return await createGitBranch(workspacePath, request.body?.name || "");
  } catch (error) {
    return reply.code(409).send({ message: error instanceof Error ? error.message : String(error) });
  }
});

app.post<{ Body: { name?: string } }>("/api/git/switch", async (request, reply) => {
  if (runningTurns.size) return reply.code(409).send({ message: "请先停止正在运行的任务，再切换分支" });
  try {
    return await switchGitBranch(workspacePath, request.body?.name || "");
  } catch (error) {
    return reply.code(409).send({ message: error instanceof Error ? error.message : String(error) });
  }
});

app.post<{ Body: { paths?: unknown; action?: GitIndexAction } }>("/api/git/index", async (request, reply) => {
  if (runningTurns.size) return reply.code(409).send({ message: "请先停止正在运行的任务，再处理暂存区" });
  const action = request.body?.action;
  if (action !== "stage" && action !== "unstage") return reply.code(400).send({ message: "未知的暂存区操作" });
  try {
    return await updateGitIndex(workspacePath, request.body?.paths, action);
  } catch (error) {
    return reply.code(409).send({ message: error instanceof Error ? error.message : String(error) });
  }
});

app.post<{ Body: { message?: string } }>("/api/git/commit", async (request, reply) => {
  if (runningTurns.size) return reply.code(409).send({ message: "请先停止正在运行的任务，再提交变更" });
  try {
    return await commitStagedChanges(workspacePath, request.body?.message || "");
  } catch (error) {
    return reply.code(409).send({ message: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/extensions", async () => extensionPayload());

app.get<{ Querystring: { scope?: SkillScope } }>("/api/marketplace", async (request, reply) => {
  const scope = request.query.scope || "global";
  if (scope !== "global" && scope !== "project") return reply.code(400).send({ message: "市场安装作用域无效" });
  return marketplacePayload(scope);
});

app.post<{ Body: { scope?: SkillScope } }>("/api/marketplace/refresh", async (request, reply) => {
  const scope = request.body?.scope || "global";
  if (scope !== "global" && scope !== "project") return reply.code(400).send({ message: "市场安装作用域无效" });
  await marketplace.refresh().catch(() => undefined);
  return marketplacePayload(scope);
});

app.post<{
  Params: { id: string };
  Body: { scope?: SkillScope; bearerTokenConfigured?: boolean };
}>("/api/marketplace/items/:id/install", async (request, reply) => {
  if (runningTurns.size) return reply.code(409).send({ message: "请先停止正在运行的任务，再安装市场扩展" });
  const item = marketplace.item(request.params.id);
  if (!item) return reply.code(404).send({ message: "市场项目不存在" });
  const scope = request.body?.scope || "global";
  if (scope !== "global" && scope !== "project") return reply.code(400).send({ message: "市场安装作用域无效" });
  try {
    if (item.kind === "skill") {
      const materialized = await marketplace.materializeSkill(item);
      try {
        await extensions.installMarketSkill(materialized.skillRoot, scope, workspacePath, item.id, item.version);
      } finally {
        await materialized.cleanup();
      }
      await applySkillRoots();
    } else {
      const installed = extensions.listMcpServers().find((server) => server.marketplaceId === item.id);
      if (item.mcp?.bearerTokenRequired && !request.body?.bearerTokenConfigured && !installed?.tokenConfigured) throw new Error("此 MCP 服务需要先填写访问令牌");
      const mcpConfig = marketplace.materializeMcp(item, workspacePath);
      mcpConfig.useBearerToken = mcpConfig.useBearerToken && Boolean(request.body?.bearerTokenConfigured || installed?.tokenConfigured);
      const change = await extensions.installMarketMcp(mcpConfig);
      try {
        await restartRuntime();
      } catch (error) {
        await extensions.rollbackMarketMcp(change.record.name, change.previous);
        await restartRuntime().catch(() => undefined);
        throw error;
      }
    }
    return reply.code(201).send(marketplacePayload(scope));
  } catch (reason) {
    return reply.code(400).send({ message: reason instanceof Error ? reason.message : String(reason) });
  }
});

app.delete<{
  Params: { id: string };
  Body: { scope?: SkillScope };
}>("/api/marketplace/items/:id", async (request, reply) => {
  if (runningTurns.size) return reply.code(409).send({ message: "请先停止正在运行的任务，再卸载市场扩展" });
  const item = marketplace.item(request.params.id);
  if (!item) return reply.code(404).send({ message: "市场项目不存在" });
  const scope = request.body?.scope || "global";
  if (scope !== "global" && scope !== "project") return reply.code(400).send({ message: "市场安装作用域无效" });
  if (item.kind === "skill") {
    const installed = extensions.listSkills(workspacePath).find((skill) => skill.marketplaceId === item.id && skill.scope === scope);
    if (!installed || !await extensions.deleteSkill(installed.id)) return reply.code(404).send({ message: "这个作用域中没有安装该 Skill" });
    await applySkillRoots();
  } else {
    const installed = extensions.listMcpServers().find((server) => server.marketplaceId === item.id);
    const previous = extensions.mcpConfigs().find((server) => server.marketplaceId === item.id);
    if (!installed || !previous || !await extensions.deleteMcpServer(installed.name)) return reply.code(404).send({ message: "该 MCP 服务尚未安装" });
    try {
      await restartRuntime();
    } catch (reason) {
      await extensions.rollbackMarketMcp(installed.name, previous);
      await restartRuntime().catch(() => undefined);
      return reply.code(400).send({ message: reason instanceof Error ? reason.message : String(reason) });
    }
  }
  return marketplacePayload(scope);
});

app.post<{ Body: { sourcePath?: string; scope?: SkillScope } }>("/api/skills/import", async (request, reply) => {
  if (runningTurns.size) return reply.code(409).send({ message: "请先停止正在运行的任务，再安装 Skill" });
  const sourcePath = request.body?.sourcePath?.trim();
  const scope = request.body?.scope;
  if (!sourcePath || !path.isAbsolute(sourcePath)) return reply.code(400).send({ message: "请选择有效的 Skill 文件夹" });
  if (scope !== "global" && scope !== "project") return reply.code(400).send({ message: "Skill 作用域无效" });
  try {
    await extensions.importSkill(sourcePath, scope, workspacePath);
    await applySkillRoots();
    return reply.code(201).send(await extensionPayload());
  } catch (reason) {
    return reply.code(400).send({ message: reason instanceof Error ? reason.message : String(reason) });
  }
});

app.patch<{ Params: { id: string }; Body: { enabled?: boolean } }>("/api/skills/:id", async (request, reply) => {
  if (runningTurns.size) return reply.code(409).send({ message: "请先停止正在运行的任务，再修改 Skill" });
  if (typeof request.body?.enabled !== "boolean") return reply.code(400).send({ message: "Skill 状态无效" });
  if (!await extensions.setSkillEnabled(request.params.id, request.body.enabled)) return reply.code(404).send({ message: "Skill 不存在" });
  await applySkillRoots();
  return extensionPayload();
});

app.delete<{ Params: { id: string } }>("/api/skills/:id", async (request, reply) => {
  if (runningTurns.size) return reply.code(409).send({ message: "请先停止正在运行的任务，再删除 Skill" });
  if (!await extensions.deleteSkill(request.params.id)) return reply.code(404).send({ message: "Skill 不存在" });
  await applySkillRoots();
  return extensionPayload();
});

app.post<{
  Body: {
    name?: string;
    transport?: "stdio" | "http";
    command?: string;
    args?: string[];
    envVars?: string[];
    url?: string;
    approvalMode?: "auto" | "prompt" | "writes";
    useBearerToken?: boolean;
  };
}>("/api/mcp/servers", async (request, reply) => {
  if (runningTurns.size) return reply.code(409).send({ message: "请先停止正在运行的任务，再添加 MCP 服务" });
  const body = request.body;
  if (!body?.name || (body.transport !== "stdio" && body.transport !== "http")) return reply.code(400).send({ message: "MCP 配置不完整" });
  try {
    const created = await extensions.addMcpServer({
      name: body.name,
      transport: body.transport,
      command: body.command,
      args: body.args,
      envVars: body.envVars,
      url: body.url,
      approvalMode: body.approvalMode,
      useBearerToken: body.useBearerToken,
    });
    try {
      await restartRuntime();
    } catch (error) {
      await extensions.deleteMcpServer(created.name);
      await restartRuntime().catch(() => undefined);
      throw error;
    }
    return reply.code(201).send(await extensionPayload());
  } catch (reason) {
    return reply.code(400).send({ message: reason instanceof Error ? reason.message : String(reason) });
  }
});

app.patch<{ Params: { name: string }; Body: { enabled?: boolean } }>("/api/mcp/servers/:name", async (request, reply) => {
  if (runningTurns.size) return reply.code(409).send({ message: "请先停止正在运行的任务，再修改 MCP 服务" });
  if (typeof request.body?.enabled !== "boolean") return reply.code(400).send({ message: "MCP 状态无效" });
  if (!await extensions.setMcpEnabled(request.params.name, request.body.enabled)) return reply.code(404).send({ message: "MCP 服务不存在" });
  try {
    await restartRuntime();
    return extensionPayload();
  } catch (reason) {
    await extensions.setMcpEnabled(request.params.name, !request.body.enabled);
    await restartRuntime().catch(() => undefined);
    return reply.code(400).send({ message: reason instanceof Error ? reason.message : String(reason) });
  }
});

app.delete<{ Params: { name: string } }>("/api/mcp/servers/:name", async (request, reply) => {
  if (runningTurns.size) return reply.code(409).send({ message: "请先停止正在运行的任务，再删除 MCP 服务" });
  if (!await extensions.deleteMcpServer(request.params.name)) return reply.code(404).send({ message: "MCP 服务不存在" });
  await restartRuntime();
  return extensionPayload();
});

app.post("/api/mcp/refresh", async (_request, reply) => {
  if (runningTurns.size) return reply.code(409).send({ message: "请先停止正在运行的任务，再刷新 MCP 服务" });
  try {
    await restartRuntime();
    return extensionPayload();
  } catch (reason) {
    return reply.code(503).send({ message: reason instanceof Error ? reason.message : String(reason) });
  }
});

app.post<{
  Params: { id: string };
  Body: { decision?: "accept" | "acceptForSession" | "decline" };
}>("/api/approvals/:id", async (request, reply) => {
  const approval = pendingApprovals.get(request.params.id);
  const decision = request.body?.decision;
  if (!approval) return reply.code(404).send({ message: "审批请求不存在或已经处理" });
  if (!decision || !approval.availableDecisions.includes(decision)) {
    return reply.code(400).send({ message: "当前审批请求不支持这个决定" });
  }
  bridge.respond(approval.rpcRequestId, approval.responseType === "mcp"
    ? {
        action: decision === "decline" ? "decline" : "accept",
        content: null,
        _meta: decision === "acceptForSession" ? { persist: "session" } : null,
      }
    : { decision });
  pendingApprovals.delete(approval.id);
  approval.respond({ type: "approvalResolved", approvalId: approval.id, decision });
  return { ok: true };
});

app.get("/api/local-profile/summary", async (_request, reply) => {
  try {
    return await store.localProfileSummary();
  } catch (error) {
    return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/local-profile/import", async (_request, reply) => {
  if (runningTurns.size) return reply.code(409).send({ message: "请先停止正在运行的任务，再导入本机资料" });
  try {
    return await store.importLocalProfile();
  } catch (error) {
    return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/cloud-sync/tasks", async (_request, reply) => {
  if (store.identityContext().mode !== "cloud") return reply.code(400).send({ message: "任务目录同步只在 Cloud 租户中可用" });
  return store.taskSyncSnapshot();
});

app.post<{ Body: { passphrase?: string } }>("/api/cloud-backup/tasks/encrypt", async (request, reply) => {
  if (store.identityContext().mode !== "cloud") return reply.code(400).send({ message: "加密云备份只在 Cloud 工作区中可用" });
  if (runningTurns.size) return reply.code(409).send({ message: "请先停止正在运行的任务，再创建云备份" });
  try {
    return await store.createEncryptedBackup(typeof request.body?.passphrase === "string" ? request.body.passphrase : "");
  } catch (error) {
    return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
  }
});

app.post<{ Body: { passphrase?: string; envelope?: EncryptedTaskBackupEnvelope } }>("/api/cloud-backup/tasks/restore", async (request, reply) => {
  if (store.identityContext().mode !== "cloud") return reply.code(400).send({ message: "加密云备份只在 Cloud 工作区中可用" });
  if (runningTurns.size) return reply.code(409).send({ message: "请先停止正在运行的任务，再恢复云备份" });
  if (!request.body?.envelope) return reply.code(400).send({ message: "加密任务备份不能为空" });
  try {
    return await store.restoreEncryptedBackup(
      request.body.envelope,
      typeof request.body.passphrase === "string" ? request.body.passphrase : "",
    );
  } catch (error) {
    return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
  }
});

app.post<{ Body: { taskId?: string; resourceVersion?: number; taskUpdatedAt?: string } }>("/api/cloud-sync/tasks/receipt", async (request, reply) => {
  if (store.identityContext().mode !== "cloud") return reply.code(400).send({ message: "任务目录同步只在 Cloud 租户中可用" });
  const { taskId, resourceVersion, taskUpdatedAt } = request.body || {};
  if (!taskId || !taskUpdatedAt || !Number.isSafeInteger(resourceVersion)) return reply.code(400).send({ message: "同步回执无效" });
  try {
    return await store.recordTaskSync(taskId, { resourceVersion: resourceVersion as number, taskUpdatedAt });
  } catch (error) {
    return reply.code(409).send({ message: error instanceof Error ? error.message : String(error) });
  }
});

app.post<{
  Params: { id: string };
  Body: { metadata?: Partial<CloudTaskMetadata>; expectedLocalUpdatedAt?: string; resourceVersion?: number };
}>("/api/cloud-sync/tasks/:id/apply", async (request, reply) => {
  if (store.identityContext().mode !== "cloud") return reply.code(400).send({ message: "任务目录同步只在 Cloud 租户中可用" });
  const { metadata, expectedLocalUpdatedAt, resourceVersion } = request.body || {};
  if (!metadata || typeof metadata.title !== "string" || typeof metadata.pinned !== "boolean"
    || typeof metadata.archived !== "boolean" || typeof metadata.updatedAt !== "string"
    || !expectedLocalUpdatedAt || !Number.isSafeInteger(resourceVersion)) {
    return reply.code(400).send({ message: "云端任务目录信息无效" });
  }
  try {
    return await store.applyCloudTaskMetadata(
      request.params.id,
      metadata as CloudTaskMetadata,
      expectedLocalUpdatedAt,
      resourceVersion as number,
    );
  } catch (error) {
    return reply.code(409).send({ message: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/cloud-sync/extensions", async (_request, reply) => {
  try {
    return extensions.extensionSyncSnapshot(workspacePath);
  } catch (error) {
    return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
  }
});

app.post<{
  Body: { kind?: "skill" | "mcp"; key?: string; resourceVersion?: number; localUpdatedAt?: string };
}>("/api/cloud-sync/extensions/receipt", async (request, reply) => {
  const { kind, key, resourceVersion, localUpdatedAt } = request.body || {};
  if ((kind !== "skill" && kind !== "mcp") || !key || !localUpdatedAt || !Number.isSafeInteger(resourceVersion)) {
    return reply.code(400).send({ message: "扩展同步回执无效" });
  }
  try {
    return await extensions.recordExtensionSync(kind, key, {
      resourceVersion: resourceVersion as number,
      localUpdatedAt,
    }, workspacePath);
  } catch (error) {
    return reply.code(409).send({ message: error instanceof Error ? error.message : String(error) });
  }
});

app.post<{
  Params: { kind: string; key: string };
  Body: { metadata?: unknown; expectedLocalUpdatedAt?: string; resourceVersion?: number };
}>("/api/cloud-sync/extensions/:kind/:key/apply", async (request, reply) => {
  if (runningTurns.size) return reply.code(409).send({ message: "请先停止正在运行的任务，再应用云端扩展目录" });
  const kind = request.params.kind;
  const { metadata, expectedLocalUpdatedAt, resourceVersion } = request.body || {};
  if ((kind !== "skill" && kind !== "mcp") || !metadata || typeof metadata !== "object" || Array.isArray(metadata)
    || !expectedLocalUpdatedAt || !Number.isSafeInteger(resourceVersion)) {
    return reply.code(400).send({ message: "云端扩展目录信息无效" });
  }
  let before: ExtensionSyncSnapshot;
  try {
    before = extensions.extensionSyncSnapshot(workspacePath);
  } catch (error) {
    return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
  }
  const previous = before.entries.find((entry) => entry.kind === kind && entry.key === request.params.key);
  const previousReceipt = before.receipts[`${kind}:${request.params.key}`];
  if (!previous) return reply.code(404).send({ message: "可同步扩展不存在" });
  let snapshot;
  try {
    snapshot = await extensions.applyCloudExtensionMetadata(
      kind,
      request.params.key,
      metadata as CloudSkillCatalogMetadata | CloudMcpCatalogMetadata,
      expectedLocalUpdatedAt,
      resourceVersion as number,
      workspacePath,
    );
  } catch (error) {
    return reply.code(409).send({ message: error instanceof Error ? error.message : String(error) });
  }
  try {
    if (kind === "skill") await applySkillRoots();
    else await restartRuntime();
    return snapshot;
  } catch (error) {
    await extensions.restoreExtensionSyncState(kind, request.params.key, previous.metadata, previousReceipt, workspacePath);
    if (kind === "skill") await applySkillRoots().catch(() => undefined);
    else await restartRuntime().catch(() => undefined);
    return reply.code(409).send({ message: error instanceof Error ? error.message : String(error) });
  }
});

app.post<{ Body: { title?: string } }>("/api/tasks", async (request, reply) => {
  const task = await store.create(request.body?.title?.trim() || "新任务", workspacePath);
  return reply.code(201).send(task);
});

app.get<{ Params: { id: string } }>("/api/tasks/:id", async (request, reply) => {
  const task = store.find(request.params.id);
  return task || reply.code(404).send({ message: "任务不存在" });
});

app.patch<{
  Params: { id: string };
  Body: { title?: string; pinned?: boolean; archived?: boolean };
}>("/api/tasks/:id", async (request, reply) => {
  const title = request.body?.title === undefined ? undefined : request.body.title.trim();
  if (title !== undefined && (!title || title.length > 80)) return reply.code(400).send({ message: "任务名称应为 1 到 80 个字符" });
  const task = await store.update(request.params.id, { title, pinned: request.body?.pinned, archived: request.body?.archived });
  return task || reply.code(404).send({ message: "任务不存在" });
});

app.delete<{ Params: { id: string } }>("/api/tasks/:id", async (request, reply) => {
  if (runningTurns.has(request.params.id)) return reply.code(409).send({ message: "请先停止任务，再删除记录" });
  if (!await store.delete(request.params.id)) return reply.code(404).send({ message: "任务不存在" });
  return reply.code(204).send();
});

app.post<{ Params: { id: string }; Body: { action?: ChangeAction } }>("/api/tasks/:id/changes", async (request, reply) => {
  const task = store.find(request.params.id);
  const action = request.body?.action;
  if (!task) return reply.code(404).send({ message: "任务不存在" });
  if (runningTurns.has(task.id)) return reply.code(409).send({ message: "请先停止任务，再处理代码变更" });
  if (action !== "revert" && action !== "reapply") return reply.code(400).send({ message: "未知的变更操作" });
  try {
    const activityIds = await applyTaskChanges(task, action);
    const updated = await store.markFileActivities(task.id, activityIds, action === "revert");
    return updated;
  } catch (error) {
    return reply.code(409).send({ message: error instanceof Error ? error.message : String(error) });
  }
});

app.post<{ Params: { id: string; turnId: string }; Body: { action?: ChangeAction } }>("/api/tasks/:id/checkpoints/:turnId", async (request, reply) => {
  const task = store.find(request.params.id);
  const action = request.body?.action;
  if (!task) return reply.code(404).send({ message: "任务不存在" });
  if (runningTurns.has(task.id)) return reply.code(409).send({ message: "请先停止任务，再处理本轮代码变更" });
  if (action !== "revert" && action !== "reapply") return reply.code(400).send({ message: "未知的检查点操作" });
  try {
    const activityIds = await applyTaskChanges(task, action, request.params.turnId);
    const updated = await store.markFileActivities(task.id, activityIds, action === "revert");
    return updated;
  } catch (error) {
    return reply.code(409).send({ message: error instanceof Error ? error.message : String(error) });
  }
});

app.post<{ Params: { id: string }; Body: { text?: string; contextPaths?: unknown } }>("/api/tasks/:id/steer", async (request, reply) => {
  const task = store.find(request.params.id);
  const controller = runningTurns.get(request.params.id);
  const text = request.body?.text?.trim();
  if (!task) return reply.code(404).send({ message: "任务不存在" });
  if (!controller) return reply.code(409).send({ message: "当前任务没有可补充的运行中回合" });
  if (!text) return reply.code(400).send({ message: "请输入补充内容" });

  let contextFiles: WorkspaceFileInfo[];
  try {
    contextFiles = await validateContextFiles(task.workspacePath || workspacePath, request.body?.contextPaths);
  } catch (error) {
    return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
  }

  const activity: Activity = {
    id: randomUUID(),
    kind: "message",
    role: "user",
    text,
    contextFiles,
    delivery: "steer",
    at: now(),
  };
  try {
    if (controller.providerId === "deepseek") {
      if (!controller.threadId) return reply.code(409).send({ message: "模型会话正在启动，请稍候再补充" });
      if (!controller.steerReady) return reply.code(409).send({ message: "当前回合正在切换，请稍候再补充" });
      await bridge.request("turn/steer", {
        threadId: controller.threadId,
        clientUserMessageId: activity.id,
        input: [{ type: "text", text: buildContextPrompt(text, contextFiles), text_elements: [] }],
        expectedTurnId: controller.turnId,
      }, 20_000);
    }
    await store.addActivity(task.id, activity);
    controller.emit({ type: "activity", activity });
    return { activity };
  } catch (error) {
    return reply.code(409).send({ message: error instanceof Error ? error.message : String(error) });
  }
});

app.post<{ Params: { id: string }; Body: { text?: string; contextPaths?: unknown } }>("/api/tasks/:id/queue", async (request, reply) => {
  const task = store.find(request.params.id);
  const controller = runningTurns.get(request.params.id);
  const text = request.body?.text?.trim();
  if (!task) return reply.code(404).send({ message: "任务不存在" });
  if (!controller) return reply.code(409).send({ message: "只有任务运行时才能加入下一轮队列" });
  if (!text) return reply.code(400).send({ message: "请输入要排队的任务内容" });
  if ((task.queuedTurns?.length || 0) >= MAX_QUEUED_TURNS) return reply.code(409).send({ message: `每个任务最多保留 ${MAX_QUEUED_TURNS} 条等待指令` });

  let contextFiles: WorkspaceFileInfo[];
  try {
    contextFiles = await validateContextFiles(task.workspacePath || workspacePath, request.body?.contextPaths);
  } catch (error) {
    return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
  }

  const clientUserMessageId = randomUUID();
  let nativeQueueId = controller.providerId === "demo" ? randomUUID() : "";
  try {
    if (controller.providerId === "deepseek") {
      if (!controller.threadId) return reply.code(409).send({ message: "模型会话正在启动，请稍候再加入队列" });
      if (!controller.steerReady) return reply.code(409).send({ message: "当前回合正在切换，请稍候再加入队列" });
      const nativeResult = await bridge.request("thread/queue/add", {
        threadId: controller.threadId,
        input: [{ type: "text", text: buildContextPrompt(text, contextFiles), text_elements: [] }],
        clientUserMessageId,
      }, 20_000) as AppServerQueueAdd;
      nativeQueueId = nativeResult.queuedSubmission?.id || "";
      if (!nativeQueueId) throw new Error("App Server 未返回队列项目 ID");
    }
    const queuedTurn: QueuedTurn = {
      id: nativeQueueId,
      clientUserMessageId,
      providerId: controller.providerId,
      text,
      contextFiles,
      createdAt: now(),
    };
    const items = await store.addQueuedTurn(task.id, queuedTurn) || [];
    controller.emit({ type: "queue", items });
    return reply.code(201).send({ items });
  } catch (error) {
    if (controller.providerId === "deepseek" && controller.threadId && nativeQueueId) {
      await bridge.request("thread/queue/delete", { threadId: controller.threadId, queuedSubmissionId: nativeQueueId }).catch(() => undefined);
    }
    return reply.code(409).send({ message: error instanceof Error ? error.message : String(error) });
  }
});

app.delete<{ Params: { id: string; queuedTurnId: string } }>("/api/tasks/:id/queue/:queuedTurnId", async (request, reply) => {
  const task = store.find(request.params.id);
  if (!task) return reply.code(404).send({ message: "任务不存在" });
  const queuedTurn = task.queuedTurns?.find((item) => item.id === request.params.queuedTurnId);
  if (!queuedTurn) return reply.code(404).send({ message: "等待任务不存在或已经开始" });
  try {
    if (queuedTurn.providerId === "deepseek") {
      const threadId = await loadedDeepSeekThread(task);
      await bridge.request("thread/queue/delete", { threadId, queuedSubmissionId: queuedTurn.id }, 20_000);
    }
    const items = await store.removeQueuedTurn(task.id, queuedTurn.id) || [];
    runningTurns.get(task.id)?.emit({ type: "queue", items });
    return { items };
  } catch (error) {
    return reply.code(409).send({ message: error instanceof Error ? error.message : String(error) });
  }
});

app.post<{ Params: { id: string }; Body: { queuedTurnIds?: unknown } }>("/api/tasks/:id/queue/reorder", async (request, reply) => {
  const task = store.find(request.params.id);
  if (!task) return reply.code(404).send({ message: "任务不存在" });
  const ids = request.body?.queuedTurnIds;
  const current = task.queuedTurns || [];
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string") || ids.length !== current.length || new Set(ids).size !== current.length || ids.some((id) => !current.some((item) => item.id === id))) {
    return reply.code(409).send({ message: "队列顺序与当前任务不一致，请刷新后重试" });
  }
  try {
    if (current[0]?.providerId === "deepseek") {
      const threadId = await loadedDeepSeekThread(task);
      await bridge.request("thread/queue/reorder", { threadId, queuedSubmissionIds: ids as string[] }, 20_000);
    }
    const items = await store.reorderQueuedTurns(task.id, ids as string[]) || [];
    runningTurns.get(task.id)?.emit({ type: "queue", items });
    return { items };
  } catch (error) {
    return reply.code(409).send({ message: error instanceof Error ? error.message : String(error) });
  }
});

app.post<{ Params: { id: string } }>("/api/tasks/:id/queue/start", async (request, reply) => {
  const task = store.find(request.params.id);
  if (!task) return reply.code(404).send({ message: "任务不存在" });
  if (runningTurns.has(task.id)) return reply.code(409).send({ message: "当前任务已经在运行" });
  const queuedTurn = task.queuedTurns?.[0];
  if (!queuedTurn) return reply.code(409).send({ message: "当前没有等待执行的任务" });
  if (queuedTurn.providerId === "deepseek" && !deepSeek.configured) {
    return reply.code(409).send({ message: "DeepSeek 尚未配置，队列已保留且未自动降级" });
  }
  await store.setState(task.id, "running");
  if (queuedTurn.providerId === "deepseek") await runDeepSeekTurn(task, undefined, undefined, reply, queuedTurn);
  else {
    const items = await store.removeQueuedTurn(task.id, queuedTurn.id) || [];
    const activity = queuedUserActivity(queuedTurn);
    await store.addActivity(task.id, activity);
    await runDemoTurn(task.id, activity, reply, items);
  }
});

app.post<{ Params: { id: string }; Body: { text?: string; providerId?: string; contextPaths?: unknown } }>(
  "/api/tasks/:id/turns",
  async (request, reply) => {
    const task = store.find(request.params.id);
    const text = request.body?.text?.trim();
    const providerId = request.body?.providerId || "demo";
    if (!task) return reply.code(404).send({ message: "任务不存在" });
    if (!text) return reply.code(400).send({ message: "请输入任务内容" });
    if (runningTurns.has(task.id)) return reply.code(409).send({ message: "当前任务已有运行中的回合" });

    const selected = providers().find((provider) => provider.id === providerId);
    if (!selected) return reply.code(400).send({ message: `未知模型提供商：${providerId}` });
    if (providerId !== "demo" && providerId !== "deepseek") {
      return reply.code(409).send({
        message: selected.configured
          ? `${selected.label} 适配器尚未接入，未执行自动降级`
          : `${selected.label} 尚未配置 API Key，未执行自动降级`,
      });
    }
    if (providerId === "deepseek" && !deepSeek.configured) {
      return reply.code(409).send({ message: "请先设置 DEEPSEEK_API_KEY 并重启 Forge，未执行自动降级" });
    }

    let contextFiles;
    try {
      contextFiles = await validateContextFiles(task.workspacePath || workspacePath, request.body?.contextPaths);
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
    const userActivity: Activity = { id: randomUUID(), kind: "message", role: "user", text, contextFiles, at: now() };
    await store.addActivity(task.id, userActivity);
    await store.setState(task.id, "running");

    if (providerId === "deepseek") await runDeepSeekTurn(task, buildContextPrompt(text, contextFiles), userActivity, reply);
    else await runDemoTurn(task.id, userActivity, reply);
  },
);

app.post<{ Params: { id: string } }>("/api/tasks/:id/stop", async (request, reply) => {
  const controller = runningTurns.get(request.params.id);
  if (!controller) return reply.code(409).send({ message: "当前没有运行中的任务" });
  controller.stopped = true;
  cancelTaskApprovals(request.params.id);
  if (controller.interrupt) await controller.interrupt().catch(() => undefined);
  return { ok: true, turnId: controller.turnId };
});

app.get("/api/terminals", async () => ({ terminals: terminals.list() }));

app.post<{ Body: { cwd?: string } }>("/api/terminals", async (request, reply) => {
  try {
    return reply.code(201).send(terminals.create(request.body?.cwd));
  } catch (reason) {
    return reply.code(400).send({ message: reason instanceof Error ? reason.message : String(reason) });
  }
});

app.get<{ Params: { id: string } }>("/api/terminals/:id/stream", async (request, reply) => {
  const terminal = terminals.find(request.params.id);
  if (!terminal) return reply.code(404).send({ message: "终端不存在" });
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const send = (event: unknown) => {
    if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  if (terminal.buffer) send({ type: "data", data: terminal.buffer });
  if (terminal.info.status === "exited") send({ type: "exit", exitCode: terminal.info.exitCode ?? 0 });
  const onEvent = (event: unknown) => send(event);
  terminal.events.on("event", onEvent);
  request.raw.once("close", () => terminal.events.off("event", onEvent));
});

app.post<{ Params: { id: string }; Body: { data?: string } }>("/api/terminals/:id/input", async (request, reply) => {
  const data = request.body?.data;
  if (typeof data !== "string" || data.length > 8192) return reply.code(400).send({ message: "终端输入无效" });
  try {
    terminals.write(request.params.id, data);
    return { ok: true };
  } catch (reason) {
    return reply.code(409).send({ message: reason instanceof Error ? reason.message : String(reason) });
  }
});

app.post<{ Params: { id: string }; Body: { cols?: number; rows?: number } }>("/api/terminals/:id/resize", async (request, reply) => {
  if (!Number.isFinite(request.body?.cols) || !Number.isFinite(request.body?.rows)) return reply.code(400).send({ message: "终端尺寸无效" });
  try {
    terminals.resize(request.params.id, request.body.cols as number, request.body.rows as number);
    return { ok: true };
  } catch (reason) {
    return reply.code(409).send({ message: reason instanceof Error ? reason.message : String(reason) });
  }
});

app.delete<{ Params: { id: string } }>("/api/terminals/:id", async (request, reply) => {
  if (!terminals.kill(request.params.id)) return reply.code(404).send({ message: "终端不存在" });
  return reply.code(204).send();
});

const webRoot = path.resolve(process.env.FORGE_WEB_ROOT || path.resolve(import.meta.dirname, "../../web/dist"));
await app.register(staticPlugin, { root: webRoot, wildcard: false });
app.get("/*", async (_request, reply) => reply.sendFile("index.html", webRoot));

app.addHook("onClose", async () => {
  terminals.close();
  bridge.stop();
});

await app.listen({ host, port });
if (process.env.FORGE_SKIP_RUNTIME_PREWARM !== "1") {
  void startRuntime().catch(() => undefined);
}
console.log(`Forge Daemon: http://${host}:${port}`);

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
