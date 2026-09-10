import { Fragment, lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle, Archive, ArrowUp, Bot, Check, ChevronDown, ChevronRight, CircleStop,
  FileCode2, FileDiff, Folder, GitBranch, LoaderCircle, MoreHorizontal, Paperclip, PanelRightClose,
  Inbox, LogOut, Pin, PlugZap, Plus, Redo2, Search, Settings, Sparkles, TerminalSquare, Undo2, UserRound, X,
} from "lucide-react";
import type { Activity, ApprovalRequest, BootstrapPayload, CloudAuthSession, ForgeTask, GitStatus, ProviderOption, QueuedTurn, RuntimeStatus, TaskStreamEvent, WorkspaceFileInfo } from "@forge/contracts";
import CloudAuthGate from "./CloudAuthGate";
import ContextFilePicker from "./ContextFilePicker";
import OnboardingDialog from "./OnboardingDialog";
import SettingsModal from "./SettingsModal";
import TurnQueue from "./TurnQueue";

const TerminalPanel = lazy(() => import("./TerminalPanel"));
const GitPanel = lazy(() => import("./GitPanel"));

const time = (value: string) => new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));

function ForgeMark() {
  return <span className="forge-mark" aria-hidden="true"><span /><span /><span /></span>;
}

function StatusDot({ status }: { status: RuntimeStatus["appServer"] }) {
  return <span className={`status-dot status-${status}`} />;
}

type MessageActivity = Extract<Activity, { kind: "message" }>;

interface ActivityTurn {
  id: string;
  user?: MessageActivity;
  events: Activity[];
}

function groupActivities(activities: Activity[]): ActivityTurn[] {
  const turns: ActivityTurn[] = [];
  for (const activity of activities) {
    if (activity.kind === "message" && activity.role === "user" && activity.delivery !== "steer") {
      turns.push({ id: activity.id, user: activity, events: [] });
      continue;
    }
    if (!turns.length) turns.push({ id: `turn-${activity.id}`, events: [] });
    turns[turns.length - 1].events.push(activity);
  }
  return turns;
}

function UserMessage({ message }: { message: MessageActivity }) {
  return (
    <article className="activity-row user-message">
      <div className="activity-icon user-icon"><UserRound size={14} /></div>
      <div className="activity-content">
        <div className="activity-meta"><strong>你</strong><span>{time(message.at)}</span></div>
        <p>{message.text}</p>
        {Boolean(message.contextFiles?.length) && <div className="message-context-files" aria-label="本轮上下文文件">
          {message.contextFiles?.map((file) => <span key={file.path} title={file.path}><FileCode2 size={12} />{file.path}</span>)}
        </div>}
      </div>
    </article>
  );
}

function OperationItem({ activity }: { activity: Activity }) {
  if (activity.kind === "message") {
    return <div className="process-note"><Sparkles size={14} /><p>{activity.text}</p></div>;
  }

  if (activity.kind === "command") {
    return (
      <div className="command-card process-card">
        <div className="command-head">
          <span className="terminal-chip"><TerminalSquare size={16} /></span>
          <span><strong>{activity.command}</strong><small>{activity.description}</small></span>
          <span className={`command-state ${activity.status}`}>
            {activity.status === "running" ? <LoaderCircle className="spin" size={14} /> : activity.status === "passed" ? <Check size={14} /> : <AlertCircle size={14} />}
            {activity.status === "running" ? "运行中" : activity.status === "passed" ? "成功" : "失败"}
          </span>
        </div>
        {activity.output && <div className="command-output"><span className="command-output-text">{activity.output}</span>{activity.duration && <span className="command-duration">{activity.duration}</span>}</div>}
      </div>
    );
  }

  if (activity.kind === "files") {
    const additions = activity.files.reduce((sum, file) => sum + file.additions, 0);
    const deletions = activity.files.reduce((sum, file) => sum + file.deletions, 0);
    return (
      <div className="files-card process-card">
        {activity.files.map((file) => (
          <div className="file-row" key={file.path}>
            <FileCode2 size={16} /><span>{file.path}</span><em className="add">+{file.additions}</em><em className="delete">−{file.deletions}</em>
          </div>
        ))}
        <div className="file-summary">{activity.files.length} 个文件 <span className="add">+{additions}</span><span className="delete">−{deletions}</span></div>
      </div>
    );
  }

  if (activity.kind === "tool") {
    return (
      <div className="command-card process-card tool-card">
        <div className="command-head">
          <span className="terminal-chip"><PlugZap size={16} /></span>
          <span><strong>{activity.server} · {activity.tool}</strong><small>MCP 工具调用</small></span>
          <span className={`command-state ${activity.status}`}>
            {activity.status === "running" ? <LoaderCircle className="spin" size={14} /> : activity.status === "passed" ? <Check size={14} /> : <AlertCircle size={14} />}
            {activity.status === "running" ? "调用中" : activity.status === "passed" ? "成功" : "失败"}
          </span>
        </div>
        {(activity.input || activity.output) && <div className="tool-details">
          {activity.input && <details><summary>输入参数</summary><pre>{activity.input}</pre></details>}
          {activity.output && <details><summary>返回结果</summary><pre>{activity.output}</pre></details>}
          {activity.duration && <span className="command-duration">{activity.duration}</span>}
        </div>}
      </div>
    );
  }

  return <div className={`process-notice tone-${activity.tone}`}><AlertCircle size={14} /><span>{activity.text}</span></div>;
}

function ForgeTurn({ turn, state, checkpointBusy, onCheckpoint }: {
  turn: ActivityTurn;
  state: ForgeTask["state"];
  checkpointBusy: boolean;
  onCheckpoint: (activity: Extract<Activity, { kind: "files" }>, action: "revert" | "reapply") => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const previousState = useRef(state);
  useEffect(() => {
    if (previousState.current === "running" && state !== "running") setExpanded(false);
    previousState.current = state;
  }, [state]);

  const finalMessage = [...turn.events].reverse().find((activity): activity is MessageActivity => activity.kind === "message" && activity.role === "assistant");
  const finalNotice = [...turn.events].reverse().find((activity) => activity.kind === "notice");
  const result = state === "failed" ? finalNotice || finalMessage : finalMessage || finalNotice;
  const steeredMessages = turn.events.filter((activity): activity is MessageActivity => activity.kind === "message" && activity.role === "user" && activity.delivery === "steer");
  const process = (result ? turn.events.filter((activity) => activity !== result) : turn.events).filter((activity) => !steeredMessages.includes(activity as MessageActivity));
  const operationCount = turn.events.filter((activity) => activity.kind === "command" || activity.kind === "files" || activity.kind === "tool").length;
  const fileCount = new Set(turn.events.flatMap((activity) => activity.kind === "files" ? activity.files.map((file) => file.path) : [])).size;
  const timestamp = result?.at || turn.events.at(-1)?.at || turn.user?.at || new Date().toISOString();
  const processId = `process-${turn.id}`;
  const fallback = state === "running" ? "正在理解任务并执行…" : state === "failed" ? "任务执行失败，请查看过程。" : state === "stopped" ? "任务已停止。" : "任务已完成。";
  const resultText = result?.kind === "message" || result?.kind === "notice" ? result.text : fallback;
  const stateLabel = state === "running" ? "正在处理" : state === "failed" ? "执行失败" : state === "stopped" ? "已停止" : "已完成";
  const checkpoint = [...turn.events].reverse().find((activity): activity is Extract<Activity, { kind: "files" }> => activity.kind === "files" && Boolean(activity.turnId));

  return (
    <article className={`activity-row forge-turn turn-${state}`}>
      <div className="activity-icon agent-icon">{state === "running" ? <LoaderCircle className="spin" size={14} /> : state === "failed" ? <AlertCircle size={14} /> : <Sparkles size={14} />}</div>
      <div className="activity-content turn-content">
        <div className="activity-meta"><strong>Forge</strong><span>{time(timestamp)}</span></div>
        {steeredMessages.length > 0 && <div className="steered-messages" aria-label="本轮补充指令">
          {steeredMessages.map((message) => <div key={message.id}><span>你的补充</span><p>{message.text}</p>{Boolean(message.contextFiles?.length) && <small><FileCode2 size={11} />{message.contextFiles?.length} 个上下文文件</small>}</div>)}
        </div>}
        <div className="turn-result">
          <p>{resultText || fallback}</p>
          <div className="turn-summary" aria-live="polite">
            <span className={`turn-state state-${state}`}>{state === "running" ? <LoaderCircle className="spin" size={13} /> : state === "failed" ? <AlertCircle size={13} /> : <Check size={13} />}{stateLabel}</span>
            {operationCount > 0 && <span>{operationCount} 项操作</span>}
            {fileCount > 0 && <span>{fileCount} 个文件</span>}
            {checkpoint && <button className={`checkpoint-action ${checkpoint.revertedAt ? "is-reverted" : ""}`} type="button" disabled={checkpointBusy || state === "running"} onClick={() => onCheckpoint(checkpoint, checkpoint.revertedAt ? "reapply" : "revert")}>
              {checkpointBusy ? <LoaderCircle className="spin" size={12} /> : checkpoint.revertedAt ? <Redo2 size={12} /> : <Undo2 size={12} />}
              {checkpoint.revertedAt ? "重新应用本轮" : "撤销本轮"}
            </button>}
          </div>
        </div>
        {process.length > 0 && <>
          <button className="process-toggle" type="button" aria-expanded={expanded} aria-controls={processId} onClick={() => setExpanded((open) => !open)}>
            {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            {expanded ? "收起过程" : `查看过程 · ${operationCount || process.length} 项操作`}
          </button>
          <div className="turn-process" id={processId} hidden={!expanded}>
            {process.map((activity) => <OperationItem key={activity.id} activity={activity} />)}
          </div>
        </>}
      </div>
    </article>
  );
}

type ChangedFile = Extract<Activity, { kind: "files" }>["files"][number];

function changedFiles(task?: ForgeTask) {
  const files = new Map<string, ChangedFile>();
  for (const activity of task?.activities || []) {
    if (activity.kind !== "files") continue;
    for (const file of activity.files) files.set(file.path, file);
  }
  return [...files.values()];
}

function DiffPanel({ files }: { files: ChangedFile[] }) {
  const [expandedPath, setExpandedPath] = useState(files[0]?.path || "");

  useEffect(() => {
    if (!files.some((file) => file.path === expandedPath)) setExpandedPath(files[0]?.path || "");
  }, [expandedPath, files]);

  if (!files.length) {
    return <div className="diff-empty"><FileDiff size={22} /><strong>暂无文件变更</strong><span>Agent 修改文件后，真实 Diff 会显示在这里。</span></div>;
  }

  return (
    <div className="diff-card">
      {files.map((file) => {
        const expanded = file.path === expandedPath;
        return <div className="diff-entry" key={file.path}>
          <button className="diff-file" type="button" aria-expanded={expanded} onClick={() => setExpandedPath(expanded ? "" : file.path)}>
            <FileCode2 size={15} /><strong>{file.path}</strong><em className="add">+{file.additions}</em><em className="delete">−{file.deletions}</em>{expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          </button>
          {expanded && <div className="diff-code" aria-label={`${file.path} 代码变更`}>
            {(file.diff || "没有可用的补丁内容").split("\n").map((line, index) => {
              const kind = line.startsWith("+") && !line.startsWith("+++") ? "added" : line.startsWith("-") && !line.startsWith("---") ? "removed" : line.startsWith("@@") ? "hunk" : "context";
              return <code className={kind} key={`${index}-${line}`}>{line || " "}</code>;
            })}
          </div>}
        </div>;
      })}
    </div>
  );
}

function ApprovalCard({ approval, busy, onDecision }: {
  approval: ApprovalRequest;
  busy: boolean;
  onDecision: (decision: "accept" | "acceptForSession" | "decline") => void;
}) {
  return <section className="approval-card" aria-labelledby={`approval-${approval.id}`}>
    <div className="approval-icon"><AlertCircle size={17} /></div>
    <div className="approval-copy">
      <strong id={`approval-${approval.id}`}>{approval.kind === "command" ? "允许执行这条命令？" : approval.kind === "files" ? "允许修改工作区文件？" : "允许调用这个 MCP 工具？"}</strong>
      {approval.command && <code>{approval.command}</code>}
      {approval.kind === "mcp" && <code>{approval.server} · {approval.tool}</code>}
      <span>{approval.reason || approval.cwd || "Agent 请求继续执行受保护的操作。"}</span>
      {approval.toolInput && <details><summary>查看输入参数</summary><pre>{approval.toolInput}</pre></details>}
    </div>
    <div className="approval-actions">
      <button type="button" disabled={busy} onClick={() => onDecision("decline")}>拒绝</button>
      {approval.availableDecisions.includes("acceptForSession") && <button type="button" disabled={busy} onClick={() => onDecision("acceptForSession")}>本次任务允许</button>}
      <button className="approval-primary" type="button" disabled={busy} onClick={() => onDecision("accept")}>允许一次</button>
    </div>
  </section>;
}

function parseSseChunk(buffer: string) {
  const blocks = buffer.split("\n\n");
  const rest = blocks.pop() || "";
  const events = blocks.flatMap((block) => {
    const line = block.split("\n").find((value) => value.startsWith("data: "));
    if (!line) return [];
    try { return [JSON.parse(line.slice(6)) as TaskStreamEvent]; } catch { return []; }
  });
  return { events, rest };
}

type AuthenticatedCloudSession = Extract<CloudAuthSession, { authenticated: true }>;

function WorkspaceApp({ cloudSession, onCloudLogout }: { cloudSession?: AuthenticatedCloudSession; onCloudLogout: () => Promise<void> }) {
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [providerId, setProviderId] = useState("");
  const [providerOpen, setProviderOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<"changes" | "git" | "terminal">("changes");
  const [inspectorOpen, setInspectorOpen] = useState(() => typeof window === "undefined" || window.innerWidth > 1180);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [taskMenuOpen, setTaskMenuOpen] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [apiKeySaving, setApiKeySaving] = useState(false);
  const [apiKeyTesting, setApiKeyTesting] = useState(false);
  const [apiKeyMessage, setApiKeyMessage] = useState("");
  const [apiKeyTone, setApiKeyTone] = useState<"neutral" | "success" | "error">("neutral");
  const [encryptedStorageAvailable, setEncryptedStorageAvailable] = useState<boolean | null>(null);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [approvalBusy, setApprovalBusy] = useState("");
  const [changeBusy, setChangeBusy] = useState(false);
  const [checkpointBusy, setCheckpointBusy] = useState("");
  const [contextPickerOpen, setContextPickerOpen] = useState(false);
  const [contextFiles, setContextFiles] = useState<WorkspaceFileInfo[]>([]);
  const [runningInputMode, setRunningInputMode] = useState<"steer" | "queue">("steer");
  const [followUpBusy, setFollowUpBusy] = useState(false);
  const [queueBusy, setQueueBusy] = useState("");
  const [cloudLogoutBusy, setCloudLogoutBusy] = useState(false);
  const feedRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const settingsDialogRef = useRef<HTMLElement>(null);
  const settingsCloseRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const paperclipRef = useRef<HTMLButtonElement>(null);

  const refresh = async () => {
    const response = await fetch("/api/bootstrap");
    if (!response.ok) throw new Error("无法连接 Forge Daemon");
    const payload = (await response.json()) as BootstrapPayload;
    setBootstrap(payload);
    setApprovals(payload.approvals);
    setSelectedTaskId((current) => payload.tasks.some((task) => task.id === current) ? current : payload.tasks.find((task) => !task.archived)?.id || "");
    setProviderId((current) => current || (payload.providers.find((provider) => provider.id === "deepseek" && provider.configured)?.id ?? "demo"));
    const deepSeekConfigured = payload.providers.some((provider) => provider.id === "deepseek" && provider.configured);
    if (deepSeekConfigured) setOnboardingOpen(false);
    else if (window.localStorage.getItem("forge:onboarding-dismissed:v1") !== "1") setOnboardingOpen(true);
  };

  useEffect(() => {
    refresh().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    const timer = window.setInterval(() => {
      fetch("/api/health").then((response) => response.json()).then((runtime: RuntimeStatus) => {
        setBootstrap((current) => current ? { ...current, runtime } : current);
      }).catch(() => undefined);
    }, 4000);
    return () => window.clearInterval(timer);
  }, []);

  const viewTasks = useMemo(() => (bootstrap?.tasks || []).filter((task) => Boolean(task.archived) === showArchived), [bootstrap?.tasks, showArchived]);
  const selectedTask = useMemo(() => viewTasks.find((task) => task.id === selectedTaskId) || viewTasks[0], [selectedTaskId, viewTasks]);
  const selectedProvider = bootstrap?.providers.find((provider) => provider.id === providerId) || bootstrap?.providers[0];
  const taskRunning = selectedTask?.state === "running" || sending;
  const timeline = useMemo(() => groupActivities(selectedTask?.activities || []), [selectedTask?.activities]);
  const visibleTasks = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    return query ? viewTasks.filter((task) => task.title.toLocaleLowerCase().includes(query)) : viewTasks;
  }, [searchQuery, viewTasks]);
  const taskChangedFiles = useMemo(() => changedFiles(selectedTask), [selectedTask]);
  const taskFileActivities = useMemo(() => selectedTask?.activities.filter((activity): activity is Extract<Activity, { kind: "files" }> => activity.kind === "files") || [], [selectedTask]);
  const appliedFileActivityCount = taskFileActivities.filter((activity) => !activity.revertedAt).length;
  const revertedFileActivityCount = taskFileActivities.filter((activity) => Boolean(activity.revertedAt)).length;
  const changeTotals = useMemo(() => taskChangedFiles.reduce((totals, file) => ({
    additions: totals.additions + file.additions,
    deletions: totals.deletions + file.deletions,
  }), { additions: 0, deletions: 0 }), [taskChangedFiles]);
  const feedCursor = selectedTask?.activities.map((activity) => {
    if (activity.kind === "message") return `${activity.id}:${activity.text.length}`;
    if (activity.kind === "command" || activity.kind === "tool") return `${activity.id}:${activity.status}:${activity.output?.length || 0}`;
    return activity.id;
  }).join("|");

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: selectedTask?.state === "running" ? "auto" : "smooth" });
  }, [feedCursor, selectedTask?.state]);

  useEffect(() => {
    if (!settingsOpen && !onboardingOpen) return;
    if (window.forgeDesktop?.getDeepSeekStatus) {
      void window.forgeDesktop.getDeepSeekStatus().then((status) => setEncryptedStorageAvailable(status.encryptedStorage)).catch(() => setEncryptedStorageAvailable(false));
    }
  }, [onboardingOpen, settingsOpen]);

  useEffect(() => {
    if (!settingsOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    settingsCloseRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setSettingsOpen(false);
        return;
      }
      if (event.key !== "Tab" || !settingsDialogRef.current) return;
      const focusable = [...settingsDialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [settingsOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
        window.setTimeout(() => searchRef.current?.focus(), 0);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const patchTask = (id: string, updater: (task: ForgeTask) => ForgeTask) => {
    setBootstrap((current) => current ? { ...current, tasks: current.tasks.map((task) => task.id === id ? updater(task) : task) } : current);
  };

  const createTask = async () => {
    const response = await fetch("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "新任务" }) });
    const task = (await response.json()) as ForgeTask;
    setBootstrap((current) => current ? { ...current, tasks: [task, ...current.tasks] } : current);
    setShowArchived(false);
    setSelectedTaskId(task.id);
    setDraft("");
    setContextPickerOpen(false);
    setContextFiles([]);
  };

  const chooseWorkspace = async () => {
    if (!window.forgeDesktop?.selectWorkspace) {
      setError("浏览器模式不能打开本机文件夹，请使用 Forge 桌面版选择项目。");
      return;
    }
    const selectedPath = await window.forgeDesktop.selectWorkspace();
    if (!selectedPath) return;
    const response = await fetch("/api/workspace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: selectedPath }),
    });
    if (!response.ok) {
      const payload = await response.json() as { message?: string };
      setError(payload.message || "切换项目失败");
      return;
    }
    const payload = await response.json() as BootstrapPayload;
    setBootstrap(payload);
    setApprovals(payload.approvals);
    setSelectedTaskId(payload.tasks[0]?.id || "");
    setDraft("");
    setContextPickerOpen(false);
    setContextFiles([]);
    setError("");
  };

  const updateSelectedTask = async (patch: { title?: string; pinned?: boolean; archived?: boolean }) => {
    if (!selectedTask) return;
    const response = await fetch(`/api/tasks/${selectedTask.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!response.ok) {
      const payload = await response.json() as { message?: string };
      setError(payload.message || "任务更新失败");
      return;
    }
    const updated = await response.json() as ForgeTask;
    patchTask(updated.id, () => updated);
    return updated;
  };

  const renameSelectedTask = async () => {
    if (!selectedTask) return;
    const title = window.prompt("新的任务名称", selectedTask.title)?.trim();
    if (!title || title === selectedTask.title) return;
    await updateSelectedTask({ title });
    setTaskMenuOpen(false);
  };

  const deleteSelectedTask = async () => {
    if (!selectedTask || !window.confirm(`永久删除任务“${selectedTask.title}”吗？此操作无法撤销。`)) return;
    const response = await fetch(`/api/tasks/${selectedTask.id}`, { method: "DELETE" });
    if (!response.ok) {
      const payload = await response.json() as { message?: string };
      setError(payload.message || "任务删除失败");
      return;
    }
    setTaskMenuOpen(false);
    setSelectedTaskId("");
    await refresh();
  };

  const archiveSelectedTask = async (archived: boolean) => {
    if (!selectedTask) return;
    const currentId = selectedTask.id;
    const updated = await updateSelectedTask({ archived });
    if (!updated) return;
    setTaskMenuOpen(false);
    const next = bootstrap?.tasks.find((task) => task.id !== currentId && Boolean(task.archived) === showArchived);
    setSelectedTaskId(next?.id || "");
  };

  const chooseTaskView = (archived: boolean) => {
    setShowArchived(archived);
    setTaskMenuOpen(false);
    setSearchQuery("");
    setSelectedTaskId(bootstrap?.tasks.find((task) => Boolean(task.archived) === archived)?.id || "");
  };

  const dismissOnboarding = () => {
    window.localStorage.setItem("forge:onboarding-dismissed:v1", "1");
    setOnboardingOpen(false);
  };

  const testDeepSeekApiKey = async () => {
    if (!window.forgeDesktop?.testDeepSeekApiKey) {
      setApiKeyTone("error");
      setApiKeyMessage("安装版支持直接测试；浏览器开发模式请检查 DEEPSEEK_API_KEY 环境变量。");
      return;
    }
    setApiKeyTesting(true);
    setApiKeyTone("neutral");
    setApiKeyMessage("");
    try {
      const result = await window.forgeDesktop.testDeepSeekApiKey(apiKeyDraft.trim() || undefined);
      setApiKeyTone("success");
      setApiKeyMessage(`连接成功 · ${result.latencyMs}ms · 检测到 ${result.modelCount} 个可用模型`);
    } catch (reason) {
      setApiKeyTone("error");
      setApiKeyMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setApiKeyTesting(false);
    }
  };

  const saveDeepSeekApiKey = async (finishOnboarding = false) => {
    const apiKey = apiKeyDraft.trim();
    if (!window.forgeDesktop?.saveDeepSeekApiKey) {
      setApiKeyMessage("浏览器开发模式请使用 DEEPSEEK_API_KEY 环境变量；安装版可在此安全保存。");
      setApiKeyTone("error");
      return;
    }
    if (!apiKey) {
      setApiKeyMessage("请输入 DeepSeek API Key。");
      setApiKeyTone("error");
      return;
    }
    setApiKeySaving(true);
    setApiKeyMessage("");
    setApiKeyTone("neutral");
    try {
      const result = await window.forgeDesktop.saveDeepSeekApiKey(apiKey);
      setApiKeyDraft("");
      setProviderId("deepseek");
      setApiKeyTone("success");
      setApiKeyMessage(result.restarted ? "密钥已加密保存，模型服务已重新加载。" : "密钥已加密保存；开发模式下请重启 pnpm dev 后生效。");
      if (finishOnboarding) dismissOnboarding();
      if (result.restarted) await refresh();
    } catch (reason) {
      setApiKeyTone("error");
      setApiKeyMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setApiKeySaving(false);
    }
  };

  const applyTaskStreamEvent = (taskId: string, event: TaskStreamEvent) => {
    if (event.type === "activity") {
      patchTask(taskId, (task) => {
        const exists = task.activities.some((item) => item.id === event.activity.id);
        return {
          ...task,
          state: "running",
          activities: exists
            ? task.activities.map((item) => item.id === event.activity.id ? event.activity : item)
            : [...task.activities, event.activity],
        };
      });
    }
    if (event.type === "queue") patchTask(taskId, (task) => ({ ...task, queuedTurns: event.items }));
    if (event.type === "approval") {
      setApprovals((current) => current.some((approval) => approval.id === event.approval.id) ? current : [...current, event.approval]);
    }
    if (event.type === "approvalResolved") {
      setApprovals((current) => current.filter((approval) => approval.id !== event.approvalId));
    }
    if (event.type === "turn") patchTask(taskId, (task) => ({ ...task, state: event.state === "started" ? "running" : event.state }));
    if (event.type === "error") setError(event.message);
  };

  const consumeTaskStream = async (response: Response, taskId: string) => {
    if (!response.body) throw new Error("浏览器不支持流式响应");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const parsed = parseSseChunk(buffer);
      buffer = parsed.rest;
      for (const event of parsed.events) applyTaskStreamEvent(taskId, event);
      if (done) break;
    }
  };

  const submitRunningInput = async () => {
    if (!selectedTask || !draft.trim() || followUpBusy) return;
    const text = draft.trim();
    const turnContextFiles = [...contextFiles];
    setDraft("");
    setFollowUpBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/tasks/${selectedTask.id}/${runningInputMode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, contextPaths: turnContextFiles.map((file) => file.path) }),
      });
      const payload = await response.json() as { message?: string; activity?: Activity; items?: QueuedTurn[] };
      if (!response.ok) throw new Error(payload.message || (runningInputMode === "steer" ? "补充指令失败" : "加入队列失败"));
      if (payload.activity) applyTaskStreamEvent(selectedTask.id, { type: "activity", activity: payload.activity });
      if (payload.items) patchTask(selectedTask.id, (task) => ({ ...task, queuedTurns: payload.items }));
      setContextPickerOpen(false);
      setContextFiles([]);
    } catch (reason) {
      setDraft((current) => current || text);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setFollowUpBusy(false);
    }
  };

  const sendTurn = async () => {
    if (!draft.trim() || followUpBusy) return;
    if ((selectedTask?.state === "running" || sending) && selectedTask) {
      await submitRunningInput();
      return;
    }
    if (sending) return;
    setError("");
    setSending(true);
    const text = draft.trim();
    const turnContextFiles = [...contextFiles];
    setDraft("");
    const controller = new AbortController();
    abortRef.current = controller;
    let accepted = false;
    try {
      let targetTask = selectedTask;
      if (!targetTask) {
        const createResponse = await fetch("/api/tasks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "新任务" }),
        });
        if (!createResponse.ok) throw new Error("无法创建任务");
        targetTask = await createResponse.json() as ForgeTask;
        setBootstrap((current) => current ? { ...current, tasks: [targetTask as ForgeTask, ...current.tasks] } : current);
        setSelectedTaskId(targetTask.id);
      }
      const response = await fetch(`/api/tasks/${targetTask.id}/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, providerId, contextPaths: turnContextFiles.map((file) => file.path) }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = await response.json() as { message?: string };
        throw new Error(payload.message || "任务启动失败");
      }
      accepted = true;
      setContextPickerOpen(false);
      setContextFiles([]);
      await consumeTaskStream(response, targetTask.id);
    } catch (reason) {
      if (!(reason instanceof DOMException && reason.name === "AbortError")) {
        if (!accepted) setDraft((current) => current || text);
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setSending(false);
      abortRef.current = null;
      if (!controller.signal.aborted) void refresh();
    }
  };

  const stopTurn = async () => {
    if (!selectedTask) return;
    await fetch(`/api/tasks/${selectedTask.id}/stop`, { method: "POST" }).catch(() => undefined);
    abortRef.current?.abort();
    patchTask(selectedTask.id, (task) => ({ ...task, state: "stopped" }));
    setSending(false);
  };

  const deleteQueuedTurn = async (queuedTurn: QueuedTurn) => {
    if (!selectedTask || queueBusy || !window.confirm(`取消等待任务“${queuedTurn.text}”吗？`)) return;
    setQueueBusy(queuedTurn.id);
    setError("");
    try {
      const response = await fetch(`/api/tasks/${selectedTask.id}/queue/${encodeURIComponent(queuedTurn.id)}`, { method: "DELETE" });
      const payload = await response.json() as { message?: string; items?: QueuedTurn[] };
      if (!response.ok || !payload.items) throw new Error(payload.message || "取消等待任务失败");
      patchTask(selectedTask.id, (task) => ({ ...task, queuedTurns: payload.items }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setQueueBusy("");
    }
  };

  const moveQueuedTurn = async (index: number, direction: -1 | 1) => {
    if (!selectedTask || queueBusy) return;
    const queuedTurns = [...(selectedTask.queuedTurns || [])];
    const targetIndex = index + direction;
    if (!queuedTurns[index] || !queuedTurns[targetIndex]) return;
    [queuedTurns[index], queuedTurns[targetIndex]] = [queuedTurns[targetIndex], queuedTurns[index]];
    setQueueBusy("reorder");
    setError("");
    try {
      const response = await fetch(`/api/tasks/${selectedTask.id}/queue/reorder`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ queuedTurnIds: queuedTurns.map((item) => item.id) }),
      });
      const payload = await response.json() as { message?: string; items?: QueuedTurn[] };
      if (!response.ok || !payload.items) throw new Error(payload.message || "调整队列顺序失败");
      patchTask(selectedTask.id, (task) => ({ ...task, queuedTurns: payload.items }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setQueueBusy("");
    }
  };

  const resumeQueuedTurns = async () => {
    if (!selectedTask || sending || queueBusy) return;
    setQueueBusy("start");
    setSending(true);
    setError("");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await fetch(`/api/tasks/${selectedTask.id}/queue/start`, { method: "POST", signal: controller.signal });
      if (!response.ok) {
        const payload = await response.json() as { message?: string };
        throw new Error(payload.message || "继续队列失败");
      }
      await consumeTaskStream(response, selectedTask.id);
    } catch (reason) {
      if (!(reason instanceof DOMException && reason.name === "AbortError")) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSending(false);
      setQueueBusy("");
      abortRef.current = null;
      if (!controller.signal.aborted) void refresh();
    }
  };

  const resolveApproval = async (approval: ApprovalRequest, decision: "accept" | "acceptForSession" | "decline") => {
    setApprovalBusy(approval.id);
    setError("");
    try {
      const response = await fetch(`/api/approvals/${approval.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (!response.ok) {
        const payload = await response.json() as { message?: string };
        throw new Error(payload.message || "审批处理失败");
      }
      setApprovals((current) => current.filter((item) => item.id !== approval.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setApprovalBusy("");
    }
  };

  const updateTaskChanges = async (action: "revert" | "reapply") => {
    if (!selectedTask || changeBusy) return;
    if (action === "revert" && !window.confirm("撤销本任务当前已应用的代码变更吗？Forge 会先检查文件是否被继续修改。")) return;
    setChangeBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/tasks/${selectedTask.id}/changes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const payload = await response.json() as ForgeTask & { message?: string };
      if (!response.ok) throw new Error(payload.message || (action === "revert" ? "撤销代码变更失败" : "重新应用代码变更失败"));
      patchTask(selectedTask.id, () => payload);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setChangeBusy(false);
    }
  };

  const updateCheckpoint = async (activity: Extract<Activity, { kind: "files" }>, action: "revert" | "reapply") => {
    if (!selectedTask || !activity.turnId || checkpointBusy) return;
    if (action === "revert" && !window.confirm("只撤销这一轮的代码变更吗？后续对话和其他轮次会保留，Forge 会先检查文件冲突。")) return;
    setCheckpointBusy(activity.turnId);
    setError("");
    try {
      const response = await fetch(`/api/tasks/${selectedTask.id}/checkpoints/${encodeURIComponent(activity.turnId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const payload = await response.json() as ForgeTask & { message?: string };
      if (!response.ok) throw new Error(payload.message || (action === "revert" ? "撤销本轮失败" : "重新应用本轮失败"));
      patchTask(selectedTask.id, () => payload);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCheckpointBusy("");
    }
  };

  const updateGitStatus = (git: GitStatus) => {
    setBootstrap((current) => current ? { ...current, git, workspace: { ...current.workspace, branch: git.branch } } : current);
  };

  const logoutCloudAccount = async () => {
    if (cloudLogoutBusy) return;
    setCloudLogoutBusy(true);
    setError("");
    try {
      await onCloudLogout();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCloudLogoutBusy(false);
    }
  };

  if (!bootstrap) {
    return (
      <main className="loading-screen"><ForgeMark />{error
        ? <><h1>Daemon 未连接</h1><p>{error}</p><button onClick={() => location.reload()}>重新连接</button></>
        : <><LoaderCircle className="spin" /><p>正在连接本机服务…</p></>}</main>
    );
  }

  return (
    <div className={`app-shell ${inspectorOpen ? "" : "inspector-closed"}`}>
      <header className="topbar">
        <button className="workspace-crumb" type="button" onClick={() => void chooseWorkspace()} title={bootstrap.workspace.path}><span>{bootstrap.workspace.name}</span><span>/</span><GitBranch size={14} /><span>{bootstrap.workspace.branch}</span><ChevronDown size={14} /></button>
        <div className="topbar-spacer" />
        <div className="provider-wrap">
          <button className="top-button provider-button" aria-expanded={providerOpen} onClick={() => setProviderOpen((open) => !open)}>
            <span>{selectedProvider?.label}</span><i>·</i><span>{selectedProvider?.model}</span><ChevronDown size={14} />
          </button>
          {providerOpen && <div className="provider-menu">
            {bootstrap.providers.map((provider: ProviderOption) => (
              <button key={provider.id} onClick={() => { setProviderId(provider.id); setProviderOpen(false); }}>
                <span><strong>{provider.label}</strong><small>{provider.model}</small></span>
                <em className={provider.configured ? "configured" : ""}>{provider.mode === "demo" ? "演示" : provider.configured ? "已配置" : "未配置"}</em>
              </button>
            ))}
            <p>不会在模型之间自动降级</p>
          </div>}
        </div>
        <button className="search-button" type="button" onClick={() => { setSearchOpen(true); window.setTimeout(() => searchRef.current?.focus(), 0); }}><Search size={15} /><span>搜索</span><kbd>Ctrl K</kbd></button>
        <button className="icon-button" aria-label="设置" onClick={() => setSettingsOpen(true)}><Settings size={17} /></button>
        <button className="icon-button inspector-toggle" aria-label="切换检查器" onClick={() => setInspectorOpen((open) => !open)}><PanelRightClose size={17} /></button>
      </header>

      <aside className="sidebar">
        <div className="sidebar-brand"><ForgeMark /><strong>Forge</strong></div>
        <button className="new-task" onClick={createTask}><Plus size={18} />新建任务</button>
        <section className="sidebar-section">
          <div className="section-title"><span>项目</span><button className="project-add" type="button" aria-label="选择项目文件夹" onClick={() => void chooseWorkspace()}><Plus size={16} /></button></div>
          <button className="project-row selected" type="button" onClick={() => void chooseWorkspace()} title={bootstrap.workspace.path}><Folder size={16} /><span>{bootstrap.workspace.name}</span></button>
          <div className="sidebar-project-meta">
            <span><GitBranch size={13} />{bootstrap.workspace.branch}</span>
            <span title={bootstrap.runtime.detail}><StatusDot status={bootstrap.runtime.appServer} />本机运行</span>
          </div>
        </section>
        <section className="sidebar-section task-section">
          <div className="section-title"><span>{showArchived ? "已归档" : "最近任务"}</span><button className="archive-toggle" type="button" aria-label={showArchived ? "返回最近任务" : "查看已归档任务"} title={showArchived ? "返回最近任务" : "查看已归档任务"} onClick={() => chooseTaskView(!showArchived)}>{showArchived ? <Inbox size={14} /> : <Archive size={14} />}</button></div>
          {searchOpen && <div className="task-search"><Search size={14} /><input ref={searchRef} value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder={showArchived ? "搜索已归档任务" : "搜索当前项目任务"} aria-label={showArchived ? "搜索已归档任务" : "搜索当前项目任务"} /><button type="button" aria-label="关闭搜索" onClick={() => { setSearchOpen(false); setSearchQuery(""); }}><X size={13} /></button></div>}
          <div className="task-list">
            {visibleTasks.map((task) => (
              <button key={task.id} className={`task-card ${task.id === selectedTask?.id ? "selected" : ""}`} onClick={() => setSelectedTaskId(task.id)}>
                <strong>{task.pinned && <Pin size={11} />}{task.title}</strong><span>{task.state === "running" && <i className="live-dot" />}{task.subtitle}</span>
              </button>
            ))}
            {!visibleTasks.length && <p className="task-empty">{searchQuery ? "没有匹配的任务" : showArchived ? "还没有归档任务" : "还没有任务"}</p>}
          </div>
        </section>
        {cloudSession && <button className="sidebar-account" type="button" aria-label={`退出 ${cloudSession.user.displayName} 的账户`} title={`${cloudSession.user.email} · ${cloudSession.tenant.name}`} disabled={cloudLogoutBusy} onClick={() => void logoutCloudAccount()}>
          <span>{cloudSession.user.displayName.slice(0, 1).toLocaleUpperCase()}</span>
          <span><strong>{cloudSession.user.displayName}</strong><small>{cloudSession.tenant.name}</small></span>
          <LogOut size={15} aria-hidden="true" />
        </button>}
        <button className="sidebar-settings" onClick={() => setSettingsOpen(true)}><Settings size={17} />设置</button>
      </aside>

      <main className="workspace-main">
        <header className="task-header">
          <div><h1>{selectedTask?.title || "新任务"}</h1><p>{selectedTask?.state === "running" ? "正在处理" : selectedTask?.state === "stopped" ? "已停止" : selectedTask?.state === "failed" ? "执行失败" : "本机任务"}<span>·</span>{selectedProvider?.mode === "demo" ? "显式演示流" : selectedProvider?.label}</p></div>
          <div className="task-actions">
            <button className={`icon-button ${selectedTask?.pinned ? "active" : ""}`} type="button" aria-label={selectedTask?.pinned ? "取消置顶任务" : "置顶任务"} disabled={!selectedTask} onClick={() => selectedTask && void updateSelectedTask({ pinned: !selectedTask.pinned })}><Pin size={16} /></button>
            <div className="task-menu-wrap">
              <button className="icon-button" type="button" aria-label="任务操作" aria-expanded={taskMenuOpen} disabled={!selectedTask} onClick={() => setTaskMenuOpen((open) => !open)}><MoreHorizontal size={17} /></button>
              {taskMenuOpen && <div className="task-menu">{showArchived ? <><button type="button" onClick={() => void archiveSelectedTask(false)}>恢复任务</button><button className="danger" type="button" onClick={() => void deleteSelectedTask()}>永久删除</button></> : <><button type="button" onClick={() => void renameSelectedTask()}>重命名</button><button type="button" onClick={() => void archiveSelectedTask(true)}>归档任务</button></>}</div>}
            </div>
          </div>
        </header>
        <div className="activity-feed" ref={feedRef}>
          {timeline.length ? timeline.map((turn, index) => <Fragment key={turn.id}>
            {turn.user && <UserMessage message={turn.user} />}
            <ForgeTurn turn={turn} state={index === timeline.length - 1 ? selectedTask?.state || "completed" : "completed"} checkpointBusy={Boolean(checkpointBusy && turn.events.some((activity) => activity.kind === "files" && activity.turnId === checkpointBusy))} onCheckpoint={(activity, action) => void updateCheckpoint(activity, action)} />
          </Fragment>) : (
            <div className="empty-task"><Bot size={28} /><h2>从一个具体目标开始</h2><p>Forge 会把命令、文件变更和结果整理在同一条时间线上。</p></div>
          )}
        </div>
        <div className="composer-wrap">
          {approvals.filter((approval) => approval.taskId === selectedTask?.id).map((approval) => (
            <ApprovalCard key={approval.id} approval={approval} busy={approvalBusy === approval.id} onDecision={(decision) => void resolveApproval(approval, decision)} />
          ))}
          <TurnQueue
            items={selectedTask?.queuedTurns || []}
            running={Boolean(taskRunning)}
            busyId={queueBusy}
            onMove={(index, direction) => void moveQueuedTurn(index, direction)}
            onDelete={(item) => void deleteQueuedTurn(item)}
            onStart={() => void resumeQueuedTurns()}
          />
          {error && <div className="inline-error" role="alert"><AlertCircle size={14} />{error}<button aria-label="关闭错误提示" onClick={() => setError("")}><X size={13} /></button></div>}
          <div className="composer">
            {contextPickerOpen && <ContextFilePicker selected={contextFiles} onChange={setContextFiles} onClose={() => {
              setContextPickerOpen(false);
              window.setTimeout(() => paperclipRef.current?.focus(), 0);
            }} />}
            {contextFiles.length > 0 && <div className="composer-context-files" aria-label="已选择的上下文文件">
              {contextFiles.map((file) => <span key={file.path} title={file.path}><FileCode2 size={13} />{file.name}<button type="button" aria-label={`移除 ${file.path}`} onClick={() => setContextFiles((current) => current.filter((item) => item.path !== file.path))}><X size={11} /></button></span>)}
            </div>}
            <textarea value={draft} disabled={showArchived} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendTurn(); }
            }} placeholder={showArchived ? "归档任务为只读，请先恢复后继续" : "描述要完成的任务…"} rows={2} />
            <div className="composer-actions">
              <button ref={paperclipRef} className={`composer-icon ${contextPickerOpen ? "active" : ""}`} type="button" aria-label="添加工作区上下文文件" aria-expanded={contextPickerOpen} aria-controls="context-file-picker" disabled={showArchived || followUpBusy} onClick={() => setContextPickerOpen((open) => !open)}><Paperclip size={18} /></button>
              <button className="context-chip" type="button" title={bootstrap.workspace.path}><FileCode2 size={15} />当前工作区</button>
              <span className="composer-spacer" />
              <span className="approval-mode">按需批准</span>
              {taskRunning && <label className="running-input-mode"><span className="sr-only">运行中输入方式</span><select value={runningInputMode} disabled={followUpBusy} onChange={(event) => setRunningInputMode(event.target.value as "steer" | "queue")}><option value="steer">补充当前任务</option><option value="queue">排到下一轮</option></select></label>}
              {taskRunning ? <>
                <button className="send-button" onClick={sendTurn} disabled={showArchived || followUpBusy || !draft.trim()} aria-label={runningInputMode === "steer" ? "补充当前任务" : "加入下一轮队列"}>{followUpBusy ? <LoaderCircle className="spin" size={16} /> : <ArrowUp size={18} />}</button>
                <button className="stop-button" onClick={stopTurn} aria-label="停止当前任务"><CircleStop size={17} /></button>
              </> : <button className="send-button" onClick={sendTurn} disabled={showArchived || !draft.trim()} aria-label="发送"><ArrowUp size={18} /></button>}
            </div>
          </div>
          <p className="composer-hint">Enter 发送 · Shift+Enter 换行</p>
        </div>
      </main>

      {inspectorOpen && <button className="inspector-scrim" type="button" aria-label="关闭检查器" onClick={() => setInspectorOpen(false)} />}
      {inspectorOpen && <aside className={`inspector ${inspectorTab === "terminal" ? "terminal-active" : inspectorTab === "git" ? "git-active" : ""}`}>
        <div className="inspector-tabs">
          <button className={inspectorTab === "changes" ? "active" : ""} onClick={() => setInspectorTab("changes")}><FileDiff size={15} />变更 {taskChangedFiles.length > 0 && <span>{taskChangedFiles.length}</span>}</button>
          <button className={inspectorTab === "git" ? "active" : ""} onClick={() => setInspectorTab("git")}><GitBranch size={15} />Git {bootstrap.git.changes.length > 0 && <span>{bootstrap.git.changes.length}</span>}</button>
          <button className={inspectorTab === "terminal" ? "active" : ""} onClick={() => setInspectorTab("terminal")}><TerminalSquare size={15} />终端</button>
          <button className="inspector-close" type="button" aria-label="关闭检查器" onClick={() => setInspectorOpen(false)}><X size={15} /></button>
        </div>
        {inspectorTab === "changes" ? <>
          <div className="change-toolbar"><span>{taskChangedFiles.length} 个文件</span><em className="add">+{changeTotals.additions}</em><em className="delete">−{changeTotals.deletions}</em><span className={`change-applied ${appliedFileActivityCount === 0 && revertedFileActivityCount > 0 ? "is-reverted" : ""}`}>{appliedFileActivityCount > 0 ? "工作区已应用" : revertedFileActivityCount > 0 ? "变更已撤销" : "暂无变更"}</span>{appliedFileActivityCount > 0 ? <button className="change-action" type="button" disabled={changeBusy || selectedTask?.state === "running"} onClick={() => void updateTaskChanges("revert")}>{changeBusy ? <LoaderCircle className="spin" size={13} /> : <Undo2 size={13} />}撤销</button> : revertedFileActivityCount > 0 ? <button className="change-action" type="button" disabled={changeBusy || selectedTask?.state === "running"} onClick={() => void updateTaskChanges("reapply")}>{changeBusy ? <LoaderCircle className="spin" size={13} /> : <Redo2 size={13} />}重新应用</button> : null}</div>
          <DiffPanel files={taskChangedFiles} />
        </> : inspectorTab === "git" ? <Suspense fallback={<div className="terminal-loading"><LoaderCircle className="spin" size={16} />正在加载 Git…</div>}><GitPanel status={bootstrap.git} taskRunning={Boolean(selectedTask?.state === "running")} onStatus={updateGitStatus} /></Suspense> : <Suspense fallback={<div className="terminal-loading"><LoaderCircle className="spin" size={16} />正在加载终端…</div>}><TerminalPanel workspacePath={bootstrap.workspace.path} /></Suspense>}
        <div className="inspector-bottom">
          {inspectorTab !== "terminal" && <button className="terminal-strip" type="button" onClick={() => setInspectorTab("terminal")}><TerminalSquare size={15} /><strong>PowerShell</strong><span /><ChevronRight size={14} /></button>}
          <div className="runtime-list">
            <div><StatusDot status="ready" /><span>Daemon</span><em>已连接</em></div>
            <div><StatusDot status={bootstrap.runtime.appServer} /><span>App Server</span><em>{bootstrap.runtime.appServer === "ready" ? "已就绪" : bootstrap.runtime.appServer === "starting" ? "启动中" : "不可用"}</em></div>
          </div>
        </div>
      </aside>}

      {settingsOpen && <SettingsModal
        dialogRef={settingsDialogRef}
        closeButtonRef={settingsCloseRef}
        providers={bootstrap.providers}
        runtime={bootstrap.runtime}
        workspacePath={bootstrap.workspace.path}
        apiKeyDraft={apiKeyDraft}
        apiKeySaving={apiKeySaving}
        apiKeyTesting={apiKeyTesting}
        apiKeyMessage={apiKeyMessage}
        apiKeyTone={apiKeyTone}
        encryptedStorageAvailable={encryptedStorageAvailable}
        onApiKeyDraftChange={setApiKeyDraft}
        onTestApiKey={() => void testDeepSeekApiKey()}
        onSaveApiKey={() => void saveDeepSeekApiKey()}
        onChooseWorkspace={() => void chooseWorkspace()}
        onClose={() => setSettingsOpen(false)}
      />}
      {onboardingOpen && <OnboardingDialog
        workspacePath={bootstrap.workspace.path}
        apiKeyDraft={apiKeyDraft}
        apiKeySaving={apiKeySaving}
        apiKeyTesting={apiKeyTesting}
        apiKeyMessage={apiKeyMessage}
        apiKeyTone={apiKeyTone}
        encryptedStorageAvailable={encryptedStorageAvailable}
        onApiKeyDraftChange={setApiKeyDraft}
        onChooseWorkspace={() => void chooseWorkspace()}
        onTestApiKey={() => void testDeepSeekApiKey()}
        onSaveApiKey={() => void saveDeepSeekApiKey(true)}
        onSkip={dismissOnboarding}
      />}
    </div>
  );
}

export function App() {
  return <CloudAuthGate>{({ session, logout }) => <WorkspaceApp cloudSession={session} onCloudLogout={logout} />}</CloudAuthGate>;
}
