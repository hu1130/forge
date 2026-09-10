import { useEffect, useState } from "react";
import { AlertTriangle, Check, Cloud, Download, LoaderCircle, RefreshCw, ShieldCheck, UploadCloud } from "lucide-react";
import type {
  CloudTaskMetadata, CloudTenantResource, CloudTenantResourcesPayload, ForgeTask,
  LocalProfileImportResult, LocalProfileSummary, TaskSyncSnapshot,
} from "@forge/contracts";

interface AuthenticatedSession {
  user: { id: string; email: string; displayName: string };
  tenant: { id: string; name: string; slug: string; role: "owner" | "admin" | "member" };
  csrfToken: string;
}

interface TaskConflict {
  local: ForgeTask;
  remote: CloudTenantResource;
  remoteMetadata: CloudTaskMetadata;
}

interface CloudWorkspacePanelProps {
  session: AuthenticatedSession;
  cloudApiBase: string;
  anyTaskRunning: boolean;
  onTasksChanged: () => Promise<void>;
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

export default function CloudWorkspacePanel(props: CloudWorkspacePanelProps) {
  const [localProfile, setLocalProfile] = useState<LocalProfileSummary | null>(null);
  const [cloudTaskCount, setCloudTaskCount] = useState(0);
  const [cloudOnlyCount, setCloudOnlyCount] = useState(0);
  const [conflicts, setConflicts] = useState<TaskConflict[]>([]);
  const [busy, setBusy] = useState<"loading" | "import" | "sync" | string>("loading");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const cloudRequest = (path: string, init?: RequestInit) => fetch(`${props.cloudApiBase}${path}`, { ...init, credentials: "include" });

  const loadOverview = async () => {
    setBusy("loading");
    setError("");
    try {
      const [localResponse, cloudResponse] = await Promise.all([
        fetch("/api/local-profile/summary"),
        cloudRequest("/v1/tenant/resources?kind=task"),
      ]);
      setLocalProfile(await responsePayload<LocalProfileSummary>(localResponse, "无法读取本机资料概况"));
      const cloud = await responsePayload<CloudTenantResourcesPayload>(cloudResponse, "无法读取云端任务目录");
      setCloudTaskCount(cloud.resources.length);
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
    if (response.status === 409) return { conflict: payload.current };
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

  const disabled = Boolean(busy) || props.anyTaskRunning;
  return <div className="cloud-workspace-panel">
    <div className="settings-heading">
      <div><h3>账户与云端目录</h3><p>管理当前个人租户的本机资料导入和任务目录同步。</p></div>
      <button type="button" disabled={Boolean(busy)} onClick={() => void loadOverview()}><RefreshCw className={busy === "loading" ? "spin" : ""} size={14} />刷新</button>
    </div>

    <div className="cloud-identity-card">
      <span><Cloud size={18} /></span>
      <div><strong>{props.session.tenant.name}</strong><small>{props.session.user.email} · {props.session.tenant.role} · 已隔离</small></div>
      <em>{cloudTaskCount} 条云端目录</em>
    </div>

    <div className="cloud-privacy-note"><ShieldCheck size={16} /><span><strong>只同步目录元数据</strong><small>任务名称、置顶、归档状态和更新时间可以进入 Cloud；代码、工作区路径、对话、终端输出与密钥不会上传。</small></span></div>

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
    </div>

    {props.anyTaskRunning && <div className="cloud-sync-warning"><AlertTriangle size={15} />请先停止正在运行的任务，再导入或同步目录。</div>}
    {(error || message) && <div className={`settings-feedback ${error ? "feedback-error" : "feedback-success"}`} role={error ? "alert" : "status"}>{error || message}</div>}
    {cloudOnlyCount > 0 && <div className="cloud-sync-warning"><Cloud size={15} />云端还有 {cloudOnlyCount} 个仅存在于其他设备的目录记录。由于完整任务没有上传，本机不会创建虚假的空任务。</div>}

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
  </div>;
}
