import { useEffect, useState } from "react";
import { AlertTriangle, Check, Cloud, Download, LoaderCircle, MonitorSmartphone, PlugZap, RefreshCw, ShieldCheck, UploadCloud } from "lucide-react";
import type {
  CloudAuthSession, CloudMcpCatalogMetadata, CloudSessionInfo, CloudSessionListPayload, CloudSkillCatalogMetadata, CloudTaskMetadata, CloudTenantResource,
  CloudTenantResourcesPayload, ExtensionCatalogEntry, ExtensionCatalogMetadata, ExtensionSyncSnapshot,
  ForgeTask, LocalProfileImportResult, LocalProfileSummary, TaskSyncSnapshot,
} from "@forge/contracts";
import CloudBackupPanel from "./CloudBackupPanel";
import CloudTeamPanel from "./CloudTeamPanel";

type AuthenticatedSession = Extract<CloudAuthSession, { authenticated: true }>;

interface TaskConflict {
  local: ForgeTask;
  remote: CloudTenantResource;
  remoteMetadata: CloudTaskMetadata;
}

interface ExtensionConflict {
  local: ExtensionCatalogEntry;
  remote: CloudTenantResource;
  remoteMetadata: ExtensionCatalogMetadata;
}

interface CloudWorkspacePanelProps {
  session: AuthenticatedSession;
  cloudApiBase: string;
  anyTaskRunning: boolean;
  onTasksChanged: () => Promise<void>;
  onExtensionsChanged: () => Promise<void>;
  showBackup?: boolean;
}

async function responsePayload<T>(response: Response, fallback: string) {
  const payload = await response.json().catch(() => ({})) as T & { message?: string };
  if (!response.ok) throw new Error(payload.message || fallback);
  return payload;
}

function taskMetadata(task: ForgeTask): CloudTaskMetadata {
  return {
    title: task.title,
    pinned: Boolean(task.pinned),
    archived: Boolean(task.archived),
    updatedAt: task.updatedAt,
  };
}

function remoteTaskMetadata(resource: CloudTenantResource): CloudTaskMetadata | undefined {
  const value = resource.payload;
  if (typeof value.title !== "string" || typeof value.pinned !== "boolean" || typeof value.archived !== "boolean"
    || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) return undefined;
  return { title: value.title, pinned: value.pinned, archived: value.archived, updatedAt: value.updatedAt };
}

function sameMetadata(left: CloudTaskMetadata, right: CloudTaskMetadata) {
  return left.title === right.title && left.pinned === right.pinned
    && left.archived === right.archived && left.updatedAt === right.updatedAt;
}

function remoteExtensionMetadata(resource: CloudTenantResource): ExtensionCatalogMetadata | undefined {
  const value = resource.payload;
  if (typeof value.marketplaceId !== "string" || typeof value.marketplaceVersion !== "string"
    || typeof value.enabled !== "boolean" || typeof value.updatedAt !== "string"
    || !Number.isFinite(Date.parse(value.updatedAt))) return undefined;
  if (resource.kind === "skill") {
    if (value.scope !== "global" && value.scope !== "project") return undefined;
    return {
      marketplaceId: value.marketplaceId,
      marketplaceVersion: value.marketplaceVersion,
      scope: value.scope,
      enabled: value.enabled,
      updatedAt: value.updatedAt,
    } satisfies CloudSkillCatalogMetadata;
  }
  if (resource.kind === "mcp") {
    if ((value.transport !== "stdio" && value.transport !== "http")
      || (value.approvalMode !== "auto" && value.approvalMode !== "prompt" && value.approvalMode !== "writes")
    ) return undefined;
    return {
      marketplaceId: value.marketplaceId,
      marketplaceVersion: value.marketplaceVersion,
      transport: value.transport,
      enabled: value.enabled,
      approvalMode: value.approvalMode,
      updatedAt: value.updatedAt,
    } satisfies CloudMcpCatalogMetadata;
  }
  return undefined;
}

function sameExtensionMetadata(left: ExtensionCatalogMetadata, right: ExtensionCatalogMetadata) {
  if ("scope" in left && "scope" in right) {
    return left.marketplaceId === right.marketplaceId && left.marketplaceVersion === right.marketplaceVersion
      && left.scope === right.scope && left.enabled === right.enabled && left.updatedAt === right.updatedAt;
  }
  if ("transport" in left && "transport" in right) {
    return left.marketplaceId === right.marketplaceId && left.marketplaceVersion === right.marketplaceVersion
      && left.transport === right.transport && left.enabled === right.enabled
      && left.approvalMode === right.approvalMode && left.updatedAt === right.updatedAt;
  }
  return false;
}

function extensionReceiptKey(entry: Pick<ExtensionCatalogEntry, "kind" | "key">) {
  return `${entry.kind}:${entry.key}`;
}

function sessionTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

export default function CloudWorkspacePanel(props: CloudWorkspacePanelProps) {
  const [localProfile, setLocalProfile] = useState<LocalProfileSummary | null>(null);
  const [cloudTaskCount, setCloudTaskCount] = useState(0);
  const [cloudOnlyCount, setCloudOnlyCount] = useState(0);
  const [conflicts, setConflicts] = useState<TaskConflict[]>([]);
  const [cloudExtensionCount, setCloudExtensionCount] = useState(0);
  const [cloudOnlyExtensionCount, setCloudOnlyExtensionCount] = useState(0);
  const [excludedExtensions, setExcludedExtensions] = useState<ExtensionSyncSnapshot["excluded"]>({ customSkills: 0, customMcpServers: 0 });
  const [extensionConflicts, setExtensionConflicts] = useState<ExtensionConflict[]>([]);
  const [sessions, setSessions] = useState<CloudSessionInfo[]>([]);
  const [sessionBusy, setSessionBusy] = useState("");
  const [busy, setBusy] = useState<"loading" | "import" | "sync" | string>("loading");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const cloudRequest = (path: string, init?: RequestInit) => fetch(`${props.cloudApiBase}${path}`, { ...init, credentials: "include" });

  const loadOverview = async () => {
    setBusy("loading");
    setError("");
    try {
      const [localResponse, cloudResponse, extensionResponse, cloudSkillsResponse, cloudMcpResponse, sessionsResponse] = await Promise.all([
        fetch("/api/local-profile/summary"),
        cloudRequest("/v1/tenant/resources?kind=task"),
        fetch("/api/cloud-sync/extensions"),
        cloudRequest("/v1/tenant/resources?kind=skill"),
        cloudRequest("/v1/tenant/resources?kind=mcp"),
        cloudRequest("/v1/auth/sessions"),
      ]);
      setLocalProfile(await responsePayload<LocalProfileSummary>(localResponse, "无法读取本机资料概况"));
      const cloud = await responsePayload<CloudTenantResourcesPayload>(cloudResponse, "无法读取云端任务目录");
      const extensionSnapshot = await responsePayload<ExtensionSyncSnapshot>(extensionResponse, "无法读取本机扩展目录");
      const cloudSkills = await responsePayload<CloudTenantResourcesPayload>(cloudSkillsResponse, "无法读取云端 Skill 目录");
      const cloudMcp = await responsePayload<CloudTenantResourcesPayload>(cloudMcpResponse, "无法读取云端 MCP 目录");
      const sessionPayload = await responsePayload<CloudSessionListPayload>(sessionsResponse, "无法读取登录设备");
      setCloudTaskCount(cloud.resources.length);
      setExcludedExtensions(extensionSnapshot.excluded);
      setCloudExtensionCount(cloudSkills.resources.length + cloudMcp.resources.length);
      setSessions(sessionPayload.sessions);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  };

  useEffect(() => { void loadOverview(); }, []);

  const recordReceipt = async (task: ForgeTask, resource: CloudTenantResource) => {
    const response = await fetch("/api/cloud-sync/tasks/receipt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: task.id, resourceVersion: resource.version, taskUpdatedAt: task.updatedAt }),
    });
    await responsePayload<TaskSyncSnapshot>(response, "无法保存本机同步回执");
  };

  const uploadTask = async (task: ForgeTask, expectedVersion: number) => {
    const response = await cloudRequest(`/v1/tenant/resources/task/${encodeURIComponent(task.id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-csrf-token": props.session.csrfToken },
      body: JSON.stringify({ payload: taskMetadata(task), expectedVersion }),
    });
    const payload = await response.json().catch(() => ({})) as CloudTenantResource & { message?: string; current?: CloudTenantResource };
    if (response.status === 409) {
      if (!payload.current) throw new Error(payload.message || "云端任务目录已被删除，请重新同步");
      return { conflict: payload.current };
    }
    if (!response.ok) throw new Error(payload.message || "任务目录上传失败");
    return { resource: payload as CloudTenantResource };
  };

  const applyRemote = async (conflict: TaskConflict) => {
    const response = await fetch(`/api/cloud-sync/tasks/${encodeURIComponent(conflict.local.id)}/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        metadata: conflict.remoteMetadata,
        expectedLocalUpdatedAt: conflict.local.updatedAt,
        resourceVersion: conflict.remote.version,
      }),
    });
    await responsePayload<ForgeTask>(response, "无法应用云端任务目录信息");
  };

  const importLocalProfile = async () => {
    if (!localProfile?.eligibleTasks || !window.confirm(`将 ${localProfile.eligibleTasks} 个本机免登录任务复制到当前租户吗？原资料不会删除，已经导入的任务会跳过。`)) return;
    setBusy("import");
    setError(""); setMessage("");
    try {
      const response = await fetch("/api/local-profile/import", { method: "POST" });
      const result = await responsePayload<LocalProfileImportResult>(response, "本机资料导入失败");
      setLocalProfile(result.summary);
      await props.onTasksChanged();
      setMessage(`已导入 ${result.imported} 个任务；原本机资料保持不变。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  };

  const syncTaskCatalog = async () => {
    setBusy("sync");
    setError(""); setMessage(""); setConflicts([]);
    try {
      const [snapshotResponse, cloudResponse] = await Promise.all([
        fetch("/api/cloud-sync/tasks"),
        cloudRequest("/v1/tenant/resources?kind=task"),
      ]);
      const snapshot = await responsePayload<TaskSyncSnapshot>(snapshotResponse, "无法读取本机同步状态");
      const cloud = await responsePayload<CloudTenantResourcesPayload>(cloudResponse, "无法读取云端任务目录");
      const remoteById = new Map(cloud.resources.map((resource) => [resource.key, resource]));
      const pending: TaskConflict[] = [];
      let uploaded = 0;
      let downloaded = 0;
      let unchanged = 0;

      for (const task of snapshot.tasks) {
        const remote = remoteById.get(task.id);
        if (!remote) {
          const result = await uploadTask(task, 0);
          if (result.resource) { await recordReceipt(task, result.resource); uploaded += 1; }
          else if (result.conflict) {
            const metadata = remoteTaskMetadata(result.conflict);
            if (metadata) pending.push({ local: task, remote: result.conflict, remoteMetadata: metadata });
          }
          continue;
        }
        remoteById.delete(task.id);
        const metadata = remoteTaskMetadata(remote);
        if (!metadata) throw new Error(`云端任务“${task.title}”的目录信息格式无效`);
        const localMetadata = taskMetadata(task);
        const receipt = snapshot.receipts[task.id];
        if (sameMetadata(localMetadata, metadata)) {
          await recordReceipt(task, remote);
          unchanged += 1;
          continue;
        }
        if (receipt && task.updatedAt !== receipt.taskUpdatedAt && remote.version === receipt.resourceVersion) {
          const result = await uploadTask(task, receipt.resourceVersion);
          if (result.resource) { await recordReceipt(task, result.resource); uploaded += 1; }
          else if (result.conflict) {
            const racedMetadata = remoteTaskMetadata(result.conflict);
            if (racedMetadata) pending.push({ local: task, remote: result.conflict, remoteMetadata: racedMetadata });
          }
          continue;
        }
        if (receipt && task.updatedAt === receipt.taskUpdatedAt && remote.version !== receipt.resourceVersion && task.state !== "running") {
          const conflict = { local: task, remote, remoteMetadata: metadata };
          await applyRemote(conflict);
          downloaded += 1;
          continue;
        }
        pending.push({ local: task, remote, remoteMetadata: metadata });
      }

      setCloudTaskCount(cloud.resources.length + uploaded);
      setCloudOnlyCount(remoteById.size);
      setConflicts(pending);
      if (downloaded) await props.onTasksChanged();
      setMessage(`同步完成：上传 ${uploaded}，应用云端 ${downloaded}，无需更新 ${unchanged}，冲突 ${pending.length}。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  };

  const resolveConflict = async (conflict: TaskConflict, choice: "local" | "cloud") => {
    setBusy(`conflict:${conflict.local.id}`);
    setError(""); setMessage("");
    try {
      if (choice === "local") {
        const result = await uploadTask(conflict.local, conflict.remote.version);
        if (!result.resource) throw new Error("云端目录再次发生变化，请重新同步后选择");
        await recordReceipt(conflict.local, result.resource);
      } else {
        await applyRemote(conflict);
        await props.onTasksChanged();
      }
      setConflicts((current) => current.filter((item) => item.local.id !== conflict.local.id));
      setMessage(choice === "local" ? "已使用本机目录信息更新云端。" : "已将云端目录信息应用到本机任务。完整对话仍只在本机。" );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  };

  const recordExtensionReceipt = async (entry: ExtensionCatalogEntry, resource: CloudTenantResource) => {
    const response = await fetch("/api/cloud-sync/extensions/receipt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: entry.kind,
        key: entry.key,
        resourceVersion: resource.version,
        localUpdatedAt: entry.metadata.updatedAt,
      }),
    });
    await responsePayload<ExtensionSyncSnapshot>(response, "无法保存扩展同步回执");
  };

  const uploadExtension = async (entry: ExtensionCatalogEntry, expectedVersion: number) => {
    const response = await cloudRequest(`/v1/tenant/resources/${entry.kind}/${encodeURIComponent(entry.key)}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-csrf-token": props.session.csrfToken },
      body: JSON.stringify({ payload: entry.metadata, expectedVersion }),
    });
    const payload = await response.json().catch(() => ({})) as CloudTenantResource & { message?: string; current?: CloudTenantResource };
    if (response.status === 409) {
      if (!payload.current) throw new Error(payload.message || "云端扩展目录已被删除，请重新同步");
      return { conflict: payload.current };
    }
    if (!response.ok) throw new Error(payload.message || "扩展目录上传失败");
    return { resource: payload as CloudTenantResource };
  };

  const applyRemoteExtension = async (conflict: ExtensionConflict) => {
    const response = await fetch(`/api/cloud-sync/extensions/${conflict.local.kind}/${encodeURIComponent(conflict.local.key)}/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        metadata: conflict.remoteMetadata,
        expectedLocalUpdatedAt: conflict.local.metadata.updatedAt,
        resourceVersion: conflict.remote.version,
      }),
    });
    await responsePayload<ExtensionSyncSnapshot>(response, "无法应用云端扩展目录信息");
  };

  const syncExtensionCatalog = async () => {
    setBusy("extension-sync");
    setError(""); setMessage(""); setExtensionConflicts([]);
    try {
      const [snapshotResponse, cloudSkillsResponse, cloudMcpResponse] = await Promise.all([
        fetch("/api/cloud-sync/extensions"),
        cloudRequest("/v1/tenant/resources?kind=skill"),
        cloudRequest("/v1/tenant/resources?kind=mcp"),
      ]);
      const snapshot = await responsePayload<ExtensionSyncSnapshot>(snapshotResponse, "无法读取本机扩展目录");
      const cloudSkills = await responsePayload<CloudTenantResourcesPayload>(cloudSkillsResponse, "无法读取云端 Skill 目录");
      const cloudMcp = await responsePayload<CloudTenantResourcesPayload>(cloudMcpResponse, "无法读取云端 MCP 目录");
      const cloudResources = [...cloudSkills.resources, ...cloudMcp.resources];
      const remoteByKey = new Map(cloudResources.map((resource) => [`${resource.kind}:${resource.key}`, resource]));
      const pending: ExtensionConflict[] = [];
      let uploaded = 0;
      let downloaded = 0;
      let unchanged = 0;

      for (const entry of snapshot.entries) {
        const key = extensionReceiptKey(entry);
        const remote = remoteByKey.get(key);
        if (!remote) {
          const result = await uploadExtension(entry, 0);
          if (result.resource) { await recordExtensionReceipt(entry, result.resource); uploaded += 1; }
          else if (result.conflict) {
            const metadata = remoteExtensionMetadata(result.conflict);
            if (metadata) pending.push({ local: entry, remote: result.conflict, remoteMetadata: metadata });
          }
          continue;
        }
        remoteByKey.delete(key);
        const metadata = remoteExtensionMetadata(remote);
        if (!metadata) throw new Error(`云端 ${entry.kind === "skill" ? "Skill" : "MCP"} 目录信息格式无效`);
        const receipt = snapshot.receipts[key];
        if (sameExtensionMetadata(entry.metadata, metadata)) {
          await recordExtensionReceipt(entry, remote);
          unchanged += 1;
          continue;
        }
        if (receipt && entry.metadata.updatedAt !== receipt.localUpdatedAt && remote.version === receipt.resourceVersion) {
          const result = await uploadExtension(entry, receipt.resourceVersion);
          if (result.resource) { await recordExtensionReceipt(entry, result.resource); uploaded += 1; }
          else if (result.conflict) {
            const racedMetadata = remoteExtensionMetadata(result.conflict);
            if (racedMetadata) pending.push({ local: entry, remote: result.conflict, remoteMetadata: racedMetadata });
          }
          continue;
        }
        if (receipt && entry.metadata.updatedAt === receipt.localUpdatedAt && remote.version !== receipt.resourceVersion) {
          const conflict = { local: entry, remote, remoteMetadata: metadata };
          await applyRemoteExtension(conflict);
          downloaded += 1;
          continue;
        }
        pending.push({ local: entry, remote, remoteMetadata: metadata });
      }

      setExcludedExtensions(snapshot.excluded);
      setCloudExtensionCount(cloudResources.length + uploaded);
      setCloudOnlyExtensionCount(remoteByKey.size);
      setExtensionConflicts(pending);
      if (downloaded) await props.onExtensionsChanged();
      setMessage(`扩展目录同步完成：上传 ${uploaded}，应用云端 ${downloaded}，无需更新 ${unchanged}，冲突 ${pending.length}。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  };

  const resolveExtensionConflict = async (conflict: ExtensionConflict, choice: "local" | "cloud") => {
    setBusy(`extension-conflict:${extensionReceiptKey(conflict.local)}`);
    setError(""); setMessage("");
    try {
      if (choice === "local") {
        const result = await uploadExtension(conflict.local, conflict.remote.version);
        if (!result.resource) throw new Error("云端扩展目录再次发生变化，请重新同步后选择");
        await recordExtensionReceipt(conflict.local, result.resource);
      } else {
        await applyRemoteExtension(conflict);
        await props.onExtensionsChanged();
      }
      setExtensionConflicts((current) => current.filter((item) => extensionReceiptKey(item.local) !== extensionReceiptKey(conflict.local)));
      setMessage(choice === "local" ? "已使用本机扩展状态更新云端。" : "已应用云端扩展状态；密钥和本机配置没有下载。" );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  };

  const revokeSession = async (target: CloudSessionInfo) => {
    if (target.current || sessionBusy) return;
    setSessionBusy(target.id); setError(""); setMessage("");
    try {
      const response = await cloudRequest(`/v1/auth/sessions/${encodeURIComponent(target.id)}`, {
        method: "DELETE",
        headers: { "x-csrf-token": props.session.csrfToken },
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { message?: string };
        throw new Error(payload.message || "无法撤销登录设备");
      }
      setSessions((current) => current.filter((session) => session.id !== target.id));
      setMessage("该设备的 Forge Cloud 会话已经撤销。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSessionBusy("");
    }
  };

  const revokeOtherSessions = async () => {
    if (sessionBusy || sessions.every((session) => session.current)
      || !window.confirm("退出其他所有设备上的 Forge Cloud 账户吗？当前设备会保持登录。")) return;
    setSessionBusy("others"); setError(""); setMessage("");
    try {
      const response = await cloudRequest("/v1/auth/sessions/revoke-others", {
        method: "POST",
        headers: { "x-csrf-token": props.session.csrfToken },
      });
      const payload = await responsePayload<{ revoked: number }>(response, "无法退出其他设备");
      setSessions((current) => current.filter((session) => session.current));
      setMessage(`已退出 ${payload.revoked} 个其他设备会话。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSessionBusy("");
    }
  };

  const disabled = Boolean(busy) || props.anyTaskRunning;
  return <div className="cloud-workspace-panel">
    <div className="settings-heading">
      <div><h3>账户与云端目录</h3><p>切换个人或团队工作区，并管理隔离的云端目录。</p></div>
      <button type="button" disabled={Boolean(busy)} onClick={() => void loadOverview()}><RefreshCw className={busy === "loading" ? "spin" : ""} size={14} />刷新</button>
    </div>

    <div className="cloud-identity-card">
      <span><Cloud size={18} /></span>
      <div><strong>{props.session.tenant.name}</strong><small>{props.session.user.email} · {{ owner: "所有者", admin: "管理员", member: "成员" }[props.session.tenant.role]} · 已隔离</small></div>
      <em>{cloudTaskCount} 个云端任务 · {cloudExtensionCount} 个云端扩展</em>
    </div>

    <CloudTeamPanel session={props.session} cloudApiBase={props.cloudApiBase} anyTaskRunning={props.anyTaskRunning} />

    <div className="cloud-privacy-note"><ShieldCheck size={16} /><span><strong>目录同步与加密备份彼此独立</strong><small>普通同步只上传任务和市场扩展的安全目录元数据。只有你主动创建端到端加密备份时，任务历史才会以密文上传；工作区文件、Skill/MCP 配置、Token 与本机路径仍不会上传。</small></span></div>

    {props.showBackup !== false && <CloudBackupPanel
      tenantId={props.session.tenant.id}
      cloudApiBase={props.cloudApiBase}
      csrfToken={props.session.csrfToken}
      anyTaskRunning={props.anyTaskRunning}
      onTasksChanged={props.onTasksChanged}
    />}

    <div className="cloud-action-grid">
      <section>
        <Download size={18} />
        <div><strong>导入本机资料</strong><p>{localProfile ? localProfile.available ? `发现 ${localProfile.totalTasks} 个任务，${localProfile.eligibleTasks} 个尚未导入。` : "没有找到本机免登录资料。" : "正在读取本机资料…"}</p></div>
        <button type="button" disabled={disabled || !localProfile?.eligibleTasks} onClick={() => void importLocalProfile()}>{busy === "import" ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}{busy === "import" ? "导入中…" : "复制到当前租户"}</button>
      </section>
      <section>
        <UploadCloud size={18} />
        <div><strong>同步任务目录</strong><p>根据本机回执合并单边更新；两端都变更时由你选择，不会静默覆盖。</p></div>
        <button type="button" disabled={disabled} onClick={() => void syncTaskCatalog()}>{busy === "sync" ? <LoaderCircle className="spin" size={14} /> : <UploadCloud size={14} />}{busy === "sync" ? "同步中…" : "立即同步"}</button>
      </section>
      <section className="cloud-extension-action">
        <PlugZap size={18} />
        <div><strong>同步 Skill/MCP 目录</strong><p>同步从扩展市场安装的版本和启用状态；自定义扩展与所有可执行配置继续留在本机。</p></div>
        <button type="button" aria-busy={busy === "extension-sync"} disabled={disabled} onClick={() => void syncExtensionCatalog()}>{busy === "extension-sync" ? <LoaderCircle className="spin" size={14} /> : <PlugZap size={14} />}{busy === "extension-sync" ? "同步中…" : "同步扩展目录"}</button>
      </section>
    </div>

    <section className="cloud-session-card" aria-labelledby="cloud-session-title">
      <div className="cloud-session-heading">
        <span><MonitorSmartphone size={17} /></span>
        <div><h4 id="cloud-session-title">当前工作区的登录设备</h4><p>会话按租户隔离；只显示时间，不采集设备名称、IP 或硬件信息。</p></div>
        <button type="button" disabled={Boolean(sessionBusy) || sessions.every((session) => session.current)} onClick={() => void revokeOtherSessions()}>{sessionBusy === "others" && <LoaderCircle className="spin" size={13} />}退出其他设备</button>
      </div>
      <div className="cloud-session-list">
        {sessions.map((loginSession) => <article key={loginSession.id}>
          <span className={loginSession.current ? "current" : ""} aria-hidden="true" />
          <div><strong>{loginSession.current ? "当前设备" : "其他登录会话"}</strong><small>登录于 {sessionTime(loginSession.createdAt)} · 到期 {sessionTime(loginSession.expiresAt)}</small></div>
          {loginSession.current ? <em>正在使用</em> : <button type="button" disabled={Boolean(sessionBusy)} onClick={() => void revokeSession(loginSession)}>{sessionBusy === loginSession.id && <LoaderCircle className="spin" size={13} />}撤销</button>}
        </article>)}
      </div>
    </section>

    {props.anyTaskRunning && <div className="cloud-sync-warning"><AlertTriangle size={15} />请先停止正在运行的任务，再导入或同步目录。</div>}
    {(error || message) && <div className={`settings-feedback ${error ? "feedback-error" : "feedback-success"}`} role={error ? "alert" : "status"}>{error || message}</div>}
    {cloudOnlyCount > 0 && <div className="cloud-sync-warning"><Cloud size={15} />云端还有 {cloudOnlyCount} 个仅存在于其他设备的目录记录。目录同步不会创建虚假的空任务；如需任务历史，请使用加密备份恢复。</div>}
    {cloudOnlyExtensionCount > 0 && <div className="cloud-sync-warning"><PlugZap size={15} />云端还有 {cloudOnlyExtensionCount} 个仅存在于其他设备的扩展目录。请在扩展市场安装对应版本后再同步，Forge 不会下载未知代码或命令。</div>}
    {(excludedExtensions.customSkills > 0 || excludedExtensions.customMcpServers > 0) && <div className="cloud-sync-warning"><ShieldCheck size={15} />本次已排除 {excludedExtensions.customSkills} 个自定义 Skill 和 {excludedExtensions.customMcpServers} 个自定义 MCP；它们的内容与配置只保存在本机。</div>}

    {conflicts.length > 0 && <section className="sync-conflicts" aria-labelledby="sync-conflicts-title">
      <div><h4 id="sync-conflicts-title">需要处理的冲突</h4><span>{conflicts.length}</span></div>
      <p>下面的任务在本机和云端都发生过变化，请明确选择保留哪一份目录信息。</p>
      {conflicts.map((conflict) => <article key={conflict.local.id}>
        <AlertTriangle size={16} />
        <div><strong>{conflict.local.title}</strong><small>本机：{conflict.local.title} · 云端：{conflict.remoteMetadata.title}</small></div>
        <div>
          <button type="button" disabled={Boolean(busy)} onClick={() => void resolveConflict(conflict, "cloud")}>使用云端</button>
          <button className="primary-small" type="button" disabled={Boolean(busy)} onClick={() => void resolveConflict(conflict, "local")}>{busy === `conflict:${conflict.local.id}` ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}使用本机</button>
        </div>
      </article>)}
    </section>}

    {extensionConflicts.length > 0 && <section className="sync-conflicts" aria-labelledby="extension-sync-conflicts-title">
      <div><h4 id="extension-sync-conflicts-title">需要处理的扩展冲突</h4><span>{extensionConflicts.length}</span></div>
      <p>这些市场扩展的本机状态和云端目录都发生过变化。选择云端只会应用安全状态，不会下载密钥、命令或自定义内容。</p>
      {extensionConflicts.map((conflict) => <article key={extensionReceiptKey(conflict.local)}>
        <AlertTriangle size={16} />
        <div><strong>{conflict.local.label} · {conflict.local.kind === "skill" ? "Skill" : "MCP"}</strong><small>本机：{conflict.local.metadata.enabled ? "已启用" : "已停用"} · 云端：{conflict.remoteMetadata.enabled ? "已启用" : "已停用"} · 版本 {conflict.remoteMetadata.marketplaceVersion}</small></div>
        <div>
          <button type="button" disabled={Boolean(busy)} onClick={() => void resolveExtensionConflict(conflict, "cloud")}>使用云端</button>
          <button className="primary-small" type="button" disabled={Boolean(busy)} onClick={() => void resolveExtensionConflict(conflict, "local")}>{busy === `extension-conflict:${extensionReceiptKey(conflict.local)}` ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}使用本机</button>
        </div>
      </article>)}
    </section>}
  </div>;
}
