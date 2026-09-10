import { useEffect, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import {
  Box, Cable, Check, Cloud, Code2, Command, FolderCog, LoaderCircle, PlugZap, Plus,
  RefreshCw, ShieldCheck, Sparkles, Store, Trash2, X,
} from "lucide-react";
import type {
  CloudAuthSession, ExtensionPayload, McpApprovalMode, McpConnectionStatus, McpServerInfo,
  McpTransport, ProviderOption, RuntimeStatus, SkillInfo, SkillScope,
} from "@forge/contracts";
import MarketplacePanel from "./MarketplacePanel";
import CloudWorkspacePanel from "./CloudWorkspacePanel";

type SettingsTab = "account" | "providers" | "marketplace" | "skills" | "mcp" | "runtime" | "workspace";
type AuthenticatedCloudSession = Extract<CloudAuthSession, { authenticated: true }>;

interface SettingsModalProps {
  dialogRef: RefObject<HTMLElement | null>;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  providers: ProviderOption[];
  runtime: RuntimeStatus;
  workspacePath: string;
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
  const [tab, setTab] = useState<SettingsTab>(props.cloudWorkspace ? "account" : "providers");
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

  return <div className="modal-backdrop" onMouseDown={props.onClose}>
    <section ref={props.dialogRef} className="settings-modal settings-modal-extended" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><h2 id="settings-title">设置</h2><p>模型、Skills 与 MCP 均由本机 Forge 运行时管理。</p></div><button ref={props.closeButtonRef} className="icon-button" aria-label="关闭设置" onClick={props.onClose}><X size={17} /></button></header>
      <nav className="settings-nav" aria-label="设置分类">
        {props.cloudWorkspace && <button className={tab === "account" ? "active" : ""} onClick={() => setTab("account")}><Cloud size={16} />账户与云端</button>}
        <button className={tab === "providers" ? "active" : ""} onClick={() => setTab("providers")}><Box size={16} />模型提供商</button>
        <button className={tab === "marketplace" ? "active" : ""} onClick={() => setTab("marketplace")}><Store size={16} />扩展市场</button>
        <button className={tab === "skills" ? "active" : ""} onClick={() => setTab("skills")}><Sparkles size={16} />Skills</button>
        <button className={tab === "mcp" ? "active" : ""} onClick={() => setTab("mcp")}><PlugZap size={16} />MCP 服务</button>
        <button className={tab === "runtime" ? "active" : ""} onClick={() => setTab("runtime")}><Command size={16} />运行时</button>
        <button className={tab === "workspace" ? "active" : ""} onClick={() => setTab("workspace")}><Code2 size={16} />工作区</button>
      </nav>
      <div className="settings-content">
        {(extensionError || extensionMessage) && <div className={`settings-feedback ${extensionError ? "feedback-error" : "feedback-success"}`} role={extensionError ? "alert" : "status"}>{extensionError || extensionMessage}</div>}

        {tab === "account" && props.cloudWorkspace && <CloudWorkspacePanel {...props.cloudWorkspace} />}

        {tab === "providers" && <>
          <h3>模型提供商</h3><p>DeepSeek 通过 Responses API 接入 Codex App Server；任何失败都会直接显示，不会自动切换模型。</p>
          {props.providers.map((provider) => <div className="provider-setting" key={provider.id}><span><strong>{provider.label}</strong><small>{provider.model}</small></span><em className={provider.configured ? "ok" : ""}>{provider.mode === "demo" ? "仅测试" : provider.configured ? "已接入" : "未配置"}</em></div>)}
          <div className="api-key-form">
            <label htmlFor="deepseek-api-key">DeepSeek API Key</label>
            <div><input id="deepseek-api-key" type="password" autoComplete="off" value={props.apiKeyDraft} onChange={(event) => props.onApiKeyDraftChange(event.target.value)} placeholder="sk-…" /><button className="secondary-key-action" type="button" disabled={props.apiKeySaving || props.apiKeyTesting || props.encryptedStorageAvailable === false} onClick={props.onTestApiKey}>{props.apiKeyTesting ? "测试中…" : "测试连接"}</button><button type="button" disabled={props.apiKeySaving || props.apiKeyTesting || props.encryptedStorageAvailable === false || !props.apiKeyDraft.trim()} onClick={props.onSaveApiKey}>{props.apiKeySaving ? "保存中…" : "安全保存"}</button></div>
            <p className={`${props.encryptedStorageAvailable === false || props.apiKeyTone === "error" ? "key-warning" : ""} ${props.apiKeyTone === "success" ? "key-success" : ""}`} role={props.apiKeyTone === "error" ? "alert" : "status"}>{props.apiKeyMessage || (window.forgeDesktop ? props.encryptedStorageAvailable === false ? "Windows 加密存储当前不可用。" : "密钥使用当前 Windows 用户凭据加密；测试连接不会发起模型对话。" : "浏览器开发模式继续使用 DEEPSEEK_API_KEY 环境变量。")}</p>
          </div>
        </>}

        {tab === "marketplace" && <MarketplacePanel scope={skillScope} onScopeChange={setSkillScope} onExtensionsChanged={() => void loadExtensions()} />}

        {tab === "skills" && <>
          <div className="settings-heading"><div><h3>Skills</h3><p>导入可复用工作流，Agent 会按名称或任务描述选择使用。</p></div><div className="heading-actions"><label htmlFor="skill-scope">作用域</label><select id="skill-scope" value={skillScope} onChange={(event) => setSkillScope(event.target.value as SkillScope)}><option value="global">所有项目</option><option value="project">当前项目</option></select><button className="primary-small" type="button" disabled={Boolean(skillBusy)} onClick={() => void importSkill()}><Plus size={14} />导入文件夹</button></div></div>
          {loadingExtensions ? <div className="settings-loading"><LoaderCircle className="spin" size={17} />正在读取 Skills…</div> : <SkillList skills={extensions.skills} busy={skillBusy} onToggle={(skill) => void toggleSkill(skill)} onDelete={(skill) => void deleteSkill(skill)} />}
        </>}

        {tab === "mcp" && <>
          <div className="settings-heading"><div><h3>MCP 服务</h3><p>连接第三方工具和数据。默认只在工具可能写入数据时请求审批。</p></div><button type="button" disabled={Boolean(mcpBusy)} onClick={() => void refreshMcp()}><RefreshCw className={mcpBusy === "refresh" ? "spin" : ""} size={14} />刷新连接</button></div>
          <form className="mcp-form" onSubmit={(event) => void addMcpServer(event)}>
            <div className="form-grid">
              <label><span>服务名称</span><input required pattern="[a-z0-9][a-z0-9_-]{0,39}" value={mcpName} onChange={(event) => setMcpName(event.target.value.toLocaleLowerCase())} placeholder="context7" /></label>
              <label><span>连接方式</span><select value={mcpTransport} onChange={(event) => setMcpTransport(event.target.value as McpTransport)}><option value="stdio">STDIO（本地命令）</option><option value="http">HTTP（远程服务）</option></select></label>
              {mcpTransport === "stdio" ? <>
                <label className="form-wide"><span>启动命令</span><input required value={mcpCommand} onChange={(event) => setMcpCommand(event.target.value)} placeholder="npx" /></label>
                <label><span>参数（每行一个）</span><textarea rows={3} value={mcpArgs} onChange={(event) => setMcpArgs(event.target.value)} placeholder={'-y\n@upstash/context7-mcp'} /></label>
                <label><span>继承环境变量名</span><textarea rows={3} value={mcpEnvVars} onChange={(event) => setMcpEnvVars(event.target.value)} placeholder={'GITHUB_TOKEN\nDATABASE_URL'} /></label>
              </> : <>
                <label className="form-wide"><span>服务地址</span><input required type="url" value={mcpUrl} onChange={(event) => setMcpUrl(event.target.value)} placeholder="https://example.com/mcp" /></label>
                <label className="form-wide"><span>Bearer Token（可选）</span><input type="password" autoComplete="off" value={mcpToken} onChange={(event) => setMcpToken(event.target.value)} placeholder={window.forgeDesktop ? "使用 Windows 加密保存" : "仅桌面版可保存"} /></label>
              </>}
              <label><span>工具审批</span><select value={mcpApprovalMode} onChange={(event) => setMcpApprovalMode(event.target.value as McpApprovalMode)}><option value="writes">写操作审批</option><option value="prompt">每次审批</option><option value="auto">自动判断</option></select></label>
            </div>
            <div className="form-submit"><span><ShieldCheck size={14} />令牌不会写入 MCP 配置或任务记录</span><button className="primary-small" type="submit" disabled={Boolean(mcpBusy)}>{mcpBusy === "create" ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}{mcpBusy === "create" ? "正在连接…" : "添加服务"}</button></div>
          </form>
          {loadingExtensions ? <div className="settings-loading"><LoaderCircle className="spin" size={17} />正在读取 MCP…</div> : <McpList servers={extensions.mcpServers} busy={mcpBusy} onToggle={(server) => void toggleMcp(server)} onDelete={(server) => void deleteMcp(server)} />}
        </>}

        {tab === "runtime" && <><h3>本机运行时</h3><p>Forge 使用独立的 Codex 数据目录，避免修改用户已有的 Codex 配置。</p><div className="runtime-settings"><div><span>Daemon</span><StateBadge state="ok"><Check size={12} />已连接</StateBadge></div><div><span>App Server</span><StateBadge state={props.runtime.appServer === "ready" ? "ok" : "warning"}>{props.runtime.appServer === "ready" ? "已就绪" : props.runtime.appServer === "starting" ? "启动中" : "不可用"}</StateBadge></div><small>{props.runtime.detail}</small></div></>}

        {tab === "workspace" && <><h3>工作区</h3><p>项目级 Skill 只会在这个工作区中加载。</p><div className="workspace-setting"><FolderCog size={18} /><div><strong>当前项目</strong><code>{props.workspacePath}</code></div><button type="button" onClick={props.onChooseWorkspace}>选择文件夹</button></div></>}
      </div>
    </section>
  </div>;
}
