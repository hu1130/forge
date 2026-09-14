import { useEffect, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import {
  ArrowLeft, Box, Cable, Check, Cloud, Code2, Command, DatabaseBackup, FolderCog, Gauge,
  Home, LoaderCircle, Paintbrush, PlugZap, Plus, RefreshCw, ShieldCheck, SlidersHorizontal,
  Sparkles, Store, Trash2, X,
} from "lucide-react";
import type {
  CloudAuthSession, ExtensionPayload, ForgeInspectorTab, McpApprovalMode, McpConnectionStatus, McpServerInfo,
  McpTransport, ProviderOption, RuntimeStatus, SkillInfo, SkillScope, WorkspacePreferences,
} from "@forge/contracts";
import MarketplacePanel from "./MarketplacePanel";
import CloudWorkspacePanel from "./CloudWorkspacePanel";
import CloudBackupPanel from "./CloudBackupPanel";
import type { AppearancePreferences } from "./App";

type SettingsTab = "overview" | "workspace" | "permissions" | "providers" | "marketplace" | "skills" | "mcp" | "appearance" | "runtime" | "account" | "backup";
type AuthenticatedCloudSession = Extract<CloudAuthSession, { authenticated: true }>;

interface SettingsModalProps {
  dialogRef: RefObject<HTMLElement | null>;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  providers: ProviderOption[];
  runtime: RuntimeStatus;
  workspacePath: string;
  workspaceName: string;
  preferences: WorkspacePreferences;
  appearance: AppearancePreferences;
  anyTaskRunning: boolean;
  apiKeyDraft: string;
  apiKeySaving: boolean;
  apiKeyTesting: boolean;
  apiKeyMessage: string;
  apiKeyTone: "neutral" | "success" | "error";
  encryptedStorageAvailable: boolean | null;
  cloudWorkspace?: {
    session: AuthenticatedCloudSession;
    cloudApiBase: string;
    anyTaskRunning: boolean;
    onTasksChanged: () => Promise<void>;
  };
  onApiKeyDraftChange: (value: string) => void;
  onTestApiKey: () => void;
  onSaveApiKey: () => void;
  onChooseWorkspace: () => void;
  onPreferencesChange: (patch: Partial<WorkspacePreferences>) => Promise<void>;
  onAppearanceChange: (patch: Partial<AppearancePreferences>) => void;
  onClose: () => void;
}

async function responsePayload<T>(response: Response, fallback: string) {
  const payload = await response.json().catch(() => ({})) as T & { message?: string };
  if (!response.ok) throw new Error(payload.message || fallback);
  return payload;
}

const mcpStatusLabels: Record<McpConnectionStatus, string> = {
  notStarted: "等待连接",
  starting: "连接中",
  connected: "已连接",
  authenticationRequired: "需要认证",
  failed: "连接失败",
  cancelled: "已取消",
  disabled: "已停用",
  unavailable: "运行时不可用",
};

function StateBadge({ state, children }: { state: "ok" | "muted" | "warning"; children: ReactNode }) {
  return <span className={`extension-badge badge-${state}`}>{children}</span>;
}

function SkillList({ skills, busy, onToggle, onDelete }: {
  skills: SkillInfo[];
  busy: string;
  onToggle: (skill: SkillInfo) => void;
  onDelete: (skill: SkillInfo) => void;
}) {
  if (!skills.length) return <div className="settings-empty"><Sparkles size={22} /><strong>还没有安装 Skill</strong><span>选择一个包含 SKILL.md 的文件夹即可导入。</span></div>;
  return <div className="extension-list">{skills.map((skill) => (
    <article className="extension-card" key={skill.id}>
      <div className="extension-icon"><Sparkles size={16} /></div>
      <div className="extension-copy">
        <div><strong>{skill.name}</strong><StateBadge state={skill.status === "ready" ? "ok" : skill.status === "error" ? "warning" : "muted"}>{skill.status === "ready" ? "可用" : skill.status === "error" ? "异常" : "已停用"}</StateBadge></div>
        <p>{skill.description}</p>
        <small>{skill.scope === "global" ? "所有项目" : "当前项目"} · 使用 ${skill.name} 调用</small>
        {skill.error && <span className="extension-error">{skill.error}</span>}
      </div>
      <div className="extension-actions">
        <button type="button" disabled={Boolean(busy)} onClick={() => onToggle(skill)}>{busy === skill.id ? "处理中…" : skill.enabled ? "停用" : "启用"}</button>
        <button className="danger-icon" type="button" aria-label={`删除 ${skill.name}`} disabled={Boolean(busy)} onClick={() => onDelete(skill)}><Trash2 size={15} /></button>
      </div>
    </article>
  ))}</div>;
}

function McpList({ servers, busy, onToggle, onDelete }: {
  servers: McpServerInfo[];
  busy: string;
  onToggle: (server: McpServerInfo) => void;
  onDelete: (server: McpServerInfo) => void;
}) {
  if (!servers.length) return <div className="settings-empty"><PlugZap size={22} /><strong>还没有 MCP 服务</strong><span>添加本地 STDIO 或远程 HTTP 服务，让 Agent 使用外部工具。</span></div>;
  return <div className="extension-list">{servers.map((server) => (
    <article className="extension-card mcp-card" key={server.name}>
      <div className="extension-icon"><Cable size={16} /></div>
      <div className="extension-copy">
        <div><strong>{server.name}</strong><StateBadge state={server.status === "connected" ? "ok" : server.status === "disabled" ? "muted" : "warning"}>{mcpStatusLabels[server.status]}</StateBadge></div>
        <p>{server.transport === "stdio" ? `${server.command} ${server.args.join(" ")}`.trim() : server.url}</p>
        <small>{server.transport.toUpperCase()} · {server.approvalMode === "writes" ? "写操作审批" : server.approvalMode === "prompt" ? "每次审批" : "自动判断"}{server.useBearerToken ? ` · ${server.tokenConfigured ? "令牌已加密" : "令牌未加载"}` : ""}</small>
        {server.tools.length > 0 && <div className="tool-tags" aria-label={`${server.name} 工具列表`}>{server.tools.map((tool) => <span key={tool.name} title={tool.description}>{tool.title || tool.name}</span>)}</div>}
      </div>
      <div className="extension-actions">
        <button type="button" disabled={Boolean(busy)} onClick={() => onToggle(server)}>{busy === server.name ? "处理中…" : server.enabled ? "停用" : "启用"}</button>
        <button className="danger-icon" type="button" aria-label={`删除 ${server.name}`} disabled={Boolean(busy)} onClick={() => onDelete(server)}><Trash2 size={15} /></button>
      </div>
    </article>
  ))}</div>;
}

export default function SettingsModal(props: SettingsModalProps) {
  const [tab, setTab] = useState<SettingsTab>("overview");
  const [extensions, setExtensions] = useState<ExtensionPayload>({ skills: [], mcpServers: [] });
  const [loadingExtensions, setLoadingExtensions] = useState(false);
  const [extensionError, setExtensionError] = useState("");
  const [extensionMessage, setExtensionMessage] = useState("");
  const [skillScope, setSkillScope] = useState<SkillScope>("global");
  const [skillBusy, setSkillBusy] = useState("");
  const [mcpBusy, setMcpBusy] = useState("");
  const [mcpName, setMcpName] = useState("");
  const [mcpTransport, setMcpTransport] = useState<McpTransport>("stdio");
  const [mcpCommand, setMcpCommand] = useState("");
  const [mcpArgs, setMcpArgs] = useState("");
  const [mcpEnvVars, setMcpEnvVars] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [mcpToken, setMcpToken] = useState("");
  const [mcpApprovalMode, setMcpApprovalMode] = useState<McpApprovalMode>("writes");
  const [preferenceBusy, setPreferenceBusy] = useState(false);
  const [preferenceMessage, setPreferenceMessage] = useState("");
  const [preferenceError, setPreferenceError] = useState("");

  const savePreferences = async (patch: Partial<WorkspacePreferences>) => {
    setPreferenceBusy(true);
    setPreferenceError("");
    setPreferenceMessage("");
    try {
      await props.onPreferencesChange(patch);
      setPreferenceMessage("设置已保存");
    } catch (reason) {
      setPreferenceError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPreferenceBusy(false);
    }
  };

  const loadExtensions = async () => {
    setLoadingExtensions(true);
    setExtensionError("");
    try {
      const response = await fetch("/api/extensions");
      setExtensions(await responsePayload<ExtensionPayload>(response, "扩展信息加载失败"));
    } catch (reason) {
      setExtensionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoadingExtensions(false);
    }
  };

  useEffect(() => {
    if (tab === "skills" || tab === "mcp") void loadExtensions();
  }, [tab]);

  useEffect(() => {
    if (!preferenceMessage) return;
    const timer = window.setTimeout(() => setPreferenceMessage(""), 2400);
    return () => window.clearTimeout(timer);
  }, [preferenceMessage]);

  const importSkill = async () => {
    if (!window.forgeDesktop?.selectSkillDirectory) {
      setExtensionError("浏览器开发模式不能选择本机 Skill，请使用 Forge 桌面版。");
      return;
    }
    const sourcePath = await window.forgeDesktop.selectSkillDirectory();
    if (!sourcePath) return;
    setSkillBusy("import");
    setExtensionError("");
    setExtensionMessage("");
    try {
      const response = await fetch("/api/skills/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourcePath, scope: skillScope }),
      });
      const payload = await responsePayload<ExtensionPayload>(response, "Skill 安装失败");
      setExtensions(payload);
      setExtensionMessage("Skill 已安装并加载到当前运行时。");
    } catch (reason) {
      setExtensionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSkillBusy("");
    }
  };

  const toggleSkill = async (skill: SkillInfo) => {
    setSkillBusy(skill.id);
    setExtensionError("");
    try {
      const response = await fetch(`/api/skills/${encodeURIComponent(skill.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !skill.enabled }),
      });
      setExtensions(await responsePayload<ExtensionPayload>(response, "Skill 状态更新失败"));
    } catch (reason) {
      setExtensionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSkillBusy("");
    }
  };

  const deleteSkill = async (skill: SkillInfo) => {
    if (!window.confirm(`确定删除 Skill“${skill.name}”吗？Forge 导入的副本会被删除。`)) return;
    setSkillBusy(skill.id);
    setExtensionError("");
    try {
      const response = await fetch(`/api/skills/${encodeURIComponent(skill.id)}`, { method: "DELETE" });
      setExtensions(await responsePayload<ExtensionPayload>(response, "Skill 删除失败"));
      setExtensionMessage("Skill 已删除，原始文件夹没有改动。");
    } catch (reason) {
      setExtensionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSkillBusy("");
    }
  };

  const addMcpServer = async (event: FormEvent) => {
    event.preventDefault();
    const name = mcpName.trim();
    setMcpBusy("create");
    setExtensionError("");
    setExtensionMessage("");
    let tokenSaved = false;
    try {
      if (mcpTransport === "http" && mcpToken.trim()) {
        if (!window.forgeDesktop?.saveMcpToken) throw new Error("Bearer Token 只能在 Forge 桌面版中加密保存");
        await window.forgeDesktop.saveMcpToken(name, mcpToken.trim());
        tokenSaved = true;
      }
      const response = await fetch("/api/mcp/servers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          transport: mcpTransport,
          command: mcpTransport === "stdio" ? mcpCommand : undefined,
          args: mcpArgs.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
          envVars: mcpEnvVars.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean),
          url: mcpTransport === "http" ? mcpUrl : undefined,
          approvalMode: mcpApprovalMode,
          useBearerToken: mcpTransport === "http" && Boolean(mcpToken.trim()),
        }),
      });
      let payload = await responsePayload<ExtensionPayload>(response, "MCP 服务添加失败");
      if (tokenSaved && window.forgeDesktop?.restartRuntime) {
        await window.forgeDesktop.restartRuntime();
        const refreshed = await fetch("/api/extensions");
        payload = await responsePayload<ExtensionPayload>(refreshed, "MCP 服务刷新失败");
      }
      setExtensions(payload);
      setMcpName(""); setMcpCommand(""); setMcpArgs(""); setMcpEnvVars(""); setMcpUrl(""); setMcpToken("");
      setExtensionMessage("MCP 服务已保存并重新连接。");
    } catch (reason) {
      if (tokenSaved && window.forgeDesktop?.deleteMcpToken) await window.forgeDesktop.deleteMcpToken(name).catch(() => undefined);
      setExtensionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setMcpBusy("");
    }
  };

  const toggleMcp = async (server: McpServerInfo) => {
    setMcpBusy(server.name);
    setExtensionError("");
    try {
      const response = await fetch(`/api/mcp/servers/${encodeURIComponent(server.name)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !server.enabled }),
      });
      setExtensions(await responsePayload<ExtensionPayload>(response, "MCP 状态更新失败"));
    } catch (reason) {
      setExtensionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setMcpBusy("");
    }
  };

  const deleteMcp = async (server: McpServerInfo) => {
    if (!window.confirm(`确定删除 MCP 服务“${server.name}”吗？`)) return;
    setMcpBusy(server.name);
    setExtensionError("");
    try {
      const response = await fetch(`/api/mcp/servers/${encodeURIComponent(server.name)}`, { method: "DELETE" });
      let payload = await responsePayload<ExtensionPayload>(response, "MCP 服务删除失败");
      if (window.forgeDesktop?.deleteMcpToken) {
        await window.forgeDesktop.deleteMcpToken(server.name);
        if (server.useBearerToken && window.forgeDesktop.restartRuntime) {
          await window.forgeDesktop.restartRuntime();
          const refreshed = await fetch("/api/extensions");
          payload = await responsePayload<ExtensionPayload>(refreshed, "MCP 服务刷新失败");
        }
      }
      setExtensions(payload);
      setExtensionMessage("MCP 服务及其加密令牌已删除。");
    } catch (reason) {
      setExtensionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setMcpBusy("");
    }
  };

  const refreshMcp = async () => {
    setMcpBusy("refresh");
    setExtensionError("");
    try {
      const response = await fetch("/api/mcp/refresh", { method: "POST" });
      setExtensions(await responsePayload<ExtensionPayload>(response, "MCP 刷新失败"));
      setExtensionMessage("MCP 连接状态已刷新。");
    } catch (reason) {
      setExtensionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setMcpBusy("");
    }
  };

  return <div className="modal-backdrop settings-backdrop">
    <section ref={props.dialogRef} className="settings-screen" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <aside className="settings-brand-rail">
        <div className="settings-brand"><span className="settings-forge-mark" aria-hidden="true" /><strong>Forge</strong></div>
        <button type="button" onClick={props.onClose}><ArrowLeft size={16} />返回工作台</button>
        <button type="button" onClick={() => setTab("workspace")}><Code2 size={16} /><span><strong>{props.workspaceName}</strong><small>当前工作区</small></span></button>
        <span className="settings-rail-spacer" />
        <div className="settings-account-summary"><span>{props.cloudWorkspace ? props.cloudWorkspace.session.user.displayName.slice(0, 1).toLocaleUpperCase() : "本"}</span><div><strong>{props.cloudWorkspace?.session.user.displayName || "本机用户"}</strong><small>{props.cloudWorkspace ? props.cloudWorkspace.session.tenant.name : "数据保存在此设备"}</small></div></div>
      </aside>

      <nav className="settings-nav" aria-label="设置分类">
        <h2 id="settings-title">设置</h2>
        <p>工作台</p>
        <button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}><Home size={16} />概览</button>
        <button className={tab === "workspace" ? "active" : ""} onClick={() => setTab("workspace")}><SlidersHorizontal size={16} />偏好设置</button>
        <button className={tab === "permissions" ? "active" : ""} onClick={() => setTab("permissions")}><ShieldCheck size={16} />权限</button>
        <button className={tab === "appearance" ? "active" : ""} onClick={() => setTab("appearance")}><Paintbrush size={16} />外观</button>
        <p>能力</p>
        <button className={tab === "providers" ? "active" : ""} onClick={() => setTab("providers")}><Box size={16} />模型提供商</button>
        <button className={tab === "marketplace" ? "active" : ""} onClick={() => setTab("marketplace")}><Store size={16} />扩展市场</button>
        <button className={tab === "skills" ? "active" : ""} onClick={() => setTab("skills")}><Sparkles size={16} />Skills</button>
        <button className={tab === "mcp" ? "active" : ""} onClick={() => setTab("mcp")}><PlugZap size={16} />MCP 服务</button>
        <p>系统</p>
        <button className={tab === "runtime" ? "active" : ""} onClick={() => setTab("runtime")}><Command size={16} />运行时</button>
        {props.cloudWorkspace && <><button className={tab === "account" ? "active" : ""} onClick={() => setTab("account")}><Cloud size={16} />账户与同步</button><button className={tab === "backup" ? "active" : ""} onClick={() => setTab("backup")}><DatabaseBackup size={16} />备份与恢复</button></>}
      </nav>

      <main className="settings-content">
        <header className="settings-page-header"><div><span>Forge / 设置</span><h3>{({ overview: "概览", workspace: "偏好设置", permissions: "权限", providers: "模型提供商", marketplace: "扩展市场", skills: "Skills", mcp: "MCP 服务", appearance: "外观", runtime: "运行时", account: "账户与同步", backup: "备份与恢复" } satisfies Record<SettingsTab, string>)[tab]}</h3></div><button ref={props.closeButtonRef} className="icon-button" aria-label="关闭设置" onClick={props.onClose}><X size={18} /></button></header>
        <div className="settings-page-body">
          {(extensionError || extensionMessage || preferenceError || preferenceMessage) && <div className={`settings-feedback ${extensionError || preferenceError ? "feedback-error" : "feedback-success"}`} role={extensionError || preferenceError ? "alert" : "status"}>{extensionError || preferenceError || extensionMessage || preferenceMessage}</div>}

          {tab === "overview" && <>
            <div className="settings-intro"><h4>让工作台按你的方式运行</h4><p>模型、审批、工作区与扩展均连接真实的 Forge 本机运行时；修改后会立即保存。</p></div>
            <div className="settings-overview-grid">
              <button type="button" onClick={() => setTab("workspace")}><SlidersHorizontal size={18} /><span><strong>默认行为</strong><small>{props.providers.find((provider) => provider.id === props.preferences.defaultProviderId)?.label || "DeepSeek"} · {props.preferences.defaultInspectorTab === "changes" ? "变更" : props.preferences.defaultInspectorTab === "git" ? "Git" : "终端"}</small></span></button>
              <button type="button" onClick={() => setTab("permissions")}><ShieldCheck size={18} /><span><strong>执行权限</strong><small>{props.preferences.approvalPolicy === "untrusted" ? "严格审批" : "按需审批"}</small></span></button>
              <button type="button" onClick={() => setTab("providers")}><Box size={18} /><span><strong>模型连接</strong><small>{props.providers.filter((provider) => provider.configured).length} 个已配置</small></span></button>
              <button type="button" onClick={() => setTab("runtime")}><Gauge size={18} /><span><strong>本机运行时</strong><small>{props.runtime.appServer === "ready" ? "App Server 已就绪" : "需要检查"}</small></span></button>
            </div>
          </>}

          {tab === "workspace" && <>
            <div className="settings-intro"><h4>默认行为</h4><p>这些设置会保存在当前 Forge 用户数据中，并用于之后启动的任务。</p></div>
            <div className="preference-list">
              <label><span><strong>默认模型</strong><small>创建或打开任务时优先选择这个模型</small></span><select value={props.preferences.defaultProviderId} disabled={preferenceBusy || props.anyTaskRunning} onChange={(event) => void savePreferences({ defaultProviderId: event.target.value as WorkspacePreferences["defaultProviderId"] })}>{props.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label} · {provider.model}{provider.configured ? "" : "（未配置）"}</option>)}</select></label>
              <label><span><strong>默认右侧面板</strong><small>首次打开工作区时显示的检查器</small></span><select value={props.preferences.defaultInspectorTab} disabled={preferenceBusy || props.anyTaskRunning} onChange={(event) => void savePreferences({ defaultInspectorTab: event.target.value as ForgeInspectorTab })}><option value="changes">变更</option><option value="git">Git</option><option value="terminal">终端</option></select></label>
              <label className="preference-toggle"><span><strong>记住右侧面板</strong><small>下次继续显示你最后使用的面板</small></span><input type="checkbox" checked={props.preferences.rememberInspectorTab} disabled={preferenceBusy || props.anyTaskRunning} onChange={(event) => void savePreferences({ rememberInspectorTab: event.target.checked })} /></label>
            </div>
            {props.anyTaskRunning && <p className="settings-inline-note">任务运行期间不能修改工作区默认行为，请先停止任务。</p>}
          </>}

          {tab === "permissions" && <>
            <div className="settings-intro"><h4>执行权限</h4><p>Forge 始终限制在当前工作区写入。审批策略会真实传给 Codex App Server。</p></div>
            <div className="preference-list">
              <label><span><strong>审批策略</strong><small>{props.preferences.approvalPolicy === "untrusted" ? "仅自动执行已知安全操作，其他操作先询问" : "由 Agent 判断何时需要向你申请批准"}</small></span><select value={props.preferences.approvalPolicy} disabled={preferenceBusy || props.anyTaskRunning} onChange={(event) => void savePreferences({ approvalPolicy: event.target.value as WorkspacePreferences["approvalPolicy"] })}><option value="untrusted">严格审批（推荐）</option><option value="on-request">按需审批</option></select></label>
            </div>
            <div className="workspace-setting"><FolderCog size={18} /><div><strong>已授权工作区</strong><code>{props.workspacePath}</code></div><button type="button" disabled={props.anyTaskRunning} onClick={props.onChooseWorkspace}>更换文件夹</button></div>
            <div className="permission-note"><ShieldCheck size={18} /><span><strong>工作区写入隔离</strong><small>Agent 的文件操作限制在上面的路径中；Forge 不提供跳过全部审批的危险模式。</small></span></div>
          </>}

          {tab === "appearance" && <>
            <div className="settings-intro"><h4>外观</h4><p>界面选项只保存在本机，不会同步到云端。</p></div>
            <div className="appearance-options" role="radiogroup" aria-label="界面密度">
              <button type="button" role="radio" aria-checked={props.appearance.density === "comfortable"} className={props.appearance.density === "comfortable" ? "selected" : ""} onClick={() => props.onAppearanceChange({ density: "comfortable" })}><span className="density-preview comfortable"><i /><i /><i /></span><strong>舒适</strong><small>更宽松的留白与阅读间距</small></button>
              <button type="button" role="radio" aria-checked={props.appearance.density === "compact"} className={props.appearance.density === "compact" ? "selected" : ""} onClick={() => props.onAppearanceChange({ density: "compact" })}><span className="density-preview compact"><i /><i /><i /><i /></span><strong>紧凑</strong><small>在同一屏幕显示更多内容</small></button>
            </div>
            <div className="preference-list"><label className="preference-toggle"><span><strong>减少动画</strong><small>关闭面板和状态切换的过渡动画</small></span><input type="checkbox" checked={props.appearance.reduceMotion} onChange={(event) => props.onAppearanceChange({ reduceMotion: event.target.checked })} /></label></div>
          </>}

          {tab === "account" && props.cloudWorkspace && <CloudWorkspacePanel {...props.cloudWorkspace} showBackup={false} onExtensionsChanged={loadExtensions} />}
          {tab === "backup" && props.cloudWorkspace && <CloudBackupPanel tenantId={props.cloudWorkspace.session.tenant.id} cloudApiBase={props.cloudWorkspace.cloudApiBase} csrfToken={props.cloudWorkspace.session.csrfToken} anyTaskRunning={props.cloudWorkspace.anyTaskRunning} onTasksChanged={props.cloudWorkspace.onTasksChanged} />}

          {tab === "providers" && <>
            <div className="settings-intro"><h4>模型提供商</h4><p>DeepSeek 通过 Responses API 接入 Codex App Server；失败会直接显示，不会静默切换模型。</p></div>
            {props.providers.map((provider) => <div className="provider-setting" key={provider.id}><span><strong>{provider.label}</strong><small>{provider.model}</small></span><em className={provider.configured ? "ok" : ""}>{provider.mode === "demo" ? "仅测试" : provider.configured ? "已接入" : "未配置"}</em></div>)}
            <div className="api-key-form">
              <label htmlFor="deepseek-api-key">DeepSeek API Key</label>
              <div><input id="deepseek-api-key" type="password" autoComplete="off" value={props.apiKeyDraft} onChange={(event) => props.onApiKeyDraftChange(event.target.value)} placeholder="sk-…" /><button className="secondary-key-action" type="button" disabled={props.apiKeySaving || props.apiKeyTesting || props.encryptedStorageAvailable === false} onClick={props.onTestApiKey}>{props.apiKeyTesting ? "测试中…" : "测试连接"}</button><button type="button" disabled={props.apiKeySaving || props.apiKeyTesting || props.encryptedStorageAvailable === false || !props.apiKeyDraft.trim()} onClick={props.onSaveApiKey}>{props.apiKeySaving ? "保存中…" : "安全保存"}</button></div>
              <p className={`${props.encryptedStorageAvailable === false || props.apiKeyTone === "error" ? "key-warning" : ""} ${props.apiKeyTone === "success" ? "key-success" : ""}`} role={props.apiKeyTone === "error" ? "alert" : "status"}>{props.apiKeyMessage || (window.forgeDesktop ? props.encryptedStorageAvailable === false ? "Windows 加密存储当前不可用。" : "密钥使用当前 Windows 用户凭据加密；测试连接不会发起模型对话。" : "浏览器开发模式继续使用 DEEPSEEK_API_KEY 环境变量。")}</p>
            </div>
          </>}

          {tab === "marketplace" && <MarketplacePanel scope={skillScope} onScopeChange={setSkillScope} onExtensionsChanged={() => void loadExtensions()} />}

          {tab === "skills" && <>
            <div className="settings-heading"><div><h4>Skills</h4><p>导入可复用工作流，Agent 会按名称或任务描述选择使用。</p></div><div className="heading-actions"><label htmlFor="skill-scope">作用域</label><select id="skill-scope" value={skillScope} onChange={(event) => setSkillScope(event.target.value as SkillScope)}><option value="global">所有项目</option><option value="project">当前项目</option></select><button className="primary-small" type="button" disabled={Boolean(skillBusy)} onClick={() => void importSkill()}><Plus size={14} />导入文件夹</button></div></div>
            {loadingExtensions ? <div className="settings-loading"><LoaderCircle className="spin" size={17} />正在读取 Skills…</div> : <SkillList skills={extensions.skills} busy={skillBusy} onToggle={(skill) => void toggleSkill(skill)} onDelete={(skill) => void deleteSkill(skill)} />}
          </>}

          {tab === "mcp" && <>
            <div className="settings-heading"><div><h4>MCP 服务</h4><p>连接第三方工具和数据。默认只在工具可能写入数据时请求审批。</p></div><button type="button" disabled={Boolean(mcpBusy)} onClick={() => void refreshMcp()}><RefreshCw className={mcpBusy === "refresh" ? "spin" : ""} size={14} />刷新连接</button></div>
            <form className="mcp-form" onSubmit={(event) => void addMcpServer(event)}><div className="form-grid">
              <label><span>服务名称</span><input required pattern="[a-z0-9][a-z0-9_-]{0,39}" value={mcpName} onChange={(event) => setMcpName(event.target.value.toLocaleLowerCase())} placeholder="context7" /></label><label><span>连接方式</span><select value={mcpTransport} onChange={(event) => setMcpTransport(event.target.value as McpTransport)}><option value="stdio">STDIO（本地命令）</option><option value="http">HTTP（远程服务）</option></select></label>
              {mcpTransport === "stdio" ? <><label className="form-wide"><span>启动命令</span><input required value={mcpCommand} onChange={(event) => setMcpCommand(event.target.value)} placeholder="npx" /></label><label><span>参数（每行一个）</span><textarea rows={3} value={mcpArgs} onChange={(event) => setMcpArgs(event.target.value)} placeholder={'-y\n@upstash/context7-mcp'} /></label><label><span>继承环境变量名</span><textarea rows={3} value={mcpEnvVars} onChange={(event) => setMcpEnvVars(event.target.value)} placeholder={'GITHUB_TOKEN\nDATABASE_URL'} /></label></> : <><label className="form-wide"><span>服务地址</span><input required type="url" value={mcpUrl} onChange={(event) => setMcpUrl(event.target.value)} placeholder="https://example.com/mcp" /></label><label className="form-wide"><span>Bearer Token（可选）</span><input type="password" autoComplete="off" value={mcpToken} onChange={(event) => setMcpToken(event.target.value)} placeholder={window.forgeDesktop ? "使用 Windows 加密保存" : "仅桌面版可保存"} /></label></>}
              <label><span>工具审批</span><select value={mcpApprovalMode} onChange={(event) => setMcpApprovalMode(event.target.value as McpApprovalMode)}><option value="writes">写操作审批</option><option value="prompt">每次审批</option><option value="auto">自动判断</option></select></label>
            </div><div className="form-submit"><span><ShieldCheck size={14} />令牌不会写入 MCP 配置或任务记录</span><button className="primary-small" type="submit" disabled={Boolean(mcpBusy)}>{mcpBusy === "create" ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}{mcpBusy === "create" ? "正在连接…" : "添加服务"}</button></div></form>
            {loadingExtensions ? <div className="settings-loading"><LoaderCircle className="spin" size={17} />正在读取 MCP…</div> : <McpList servers={extensions.mcpServers} busy={mcpBusy} onToggle={(server) => void toggleMcp(server)} onDelete={(server) => void deleteMcp(server)} />}
          </>}

          {tab === "runtime" && <><div className="settings-intro"><h4>本机运行时</h4><p>Forge 使用独立的 Codex 数据目录，不修改你已有的 Codex 配置。</p></div><div className="runtime-settings"><div><span>Daemon</span><StateBadge state="ok"><Check size={12} />已连接</StateBadge></div><div><span>App Server</span><StateBadge state={props.runtime.appServer === "ready" ? "ok" : "warning"}>{props.runtime.appServer === "ready" ? "已就绪" : props.runtime.appServer === "starting" ? "启动中" : "不可用"}</StateBadge></div><small>{props.runtime.detail}</small></div></>}
        </div>
      </main>
    </section>
  </div>;
}
