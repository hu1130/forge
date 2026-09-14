import { useCallback, useEffect, useState } from "react";
import { CloudUpload, Download, KeyRound, LoaderCircle, LockKeyhole, Trash2 } from "lucide-react";
import type {
  CloudTaskBackupDownloadPayload, CloudTaskBackupMetadata, CloudTaskBackupStatusPayload,
  TaskBackupCreateResult, TaskBackupRestoreResult,
} from "@forge/contracts";

interface CloudBackupPanelProps {
  tenantId: string;
  cloudApiBase: string;
  csrfToken: string;
  anyTaskRunning: boolean;
  onTasksChanged: () => Promise<void>;
}

async function responsePayload<T>(response: Response, fallback: string) {
  const payload = await response.json().catch(() => ({})) as T & { message?: string };
  if (!response.ok) throw new Error(payload.message || fallback);
  return payload;
}

function backupTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function backupSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function CloudBackupPanel(props: CloudBackupPanelProps) {
  const [backup, setBackup] = useState<CloudTaskBackupMetadata | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"" | "backup" | "restore" | "delete">("");
  const [backupPassphrase, setBackupPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [restorePassphrase, setRestorePassphrase] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const cloudRequest = useCallback((path: string, init?: RequestInit) => fetch(`${props.cloudApiBase}${path}`, {
    ...init,
    credentials: "include",
  }), [props.cloudApiBase]);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await cloudRequest("/v1/backups/tasks");
      const payload = await responsePayload<CloudTaskBackupStatusPayload>(response, "无法读取云端备份状态");
      setBackup(payload.backup || null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [cloudRequest]);

  useEffect(() => {
    setBackupPassphrase("");
    setConfirmation("");
    setRestorePassphrase("");
    setMessage("");
    void loadStatus();
  }, [props.tenantId, loadStatus]);

  const createBackup = async () => {
    setError("");
    setMessage("");
    if (backupPassphrase.length < 12) return setError("备份口令至少需要 12 个字符");
    if (backupPassphrase !== confirmation) return setError("两次输入的备份口令不一致");
    if (backup && !window.confirm("这会用当前设备的任务替换上一份云端备份。确定继续吗？")) return;
    setBusy("backup");
    try {
      const localResponse = await fetch("/api/cloud-backup/tasks/encrypt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passphrase: backupPassphrase }),
      });
      const encrypted = await responsePayload<TaskBackupCreateResult>(localResponse, "无法在本机创建加密备份");
      const cloudResponse = await cloudRequest("/v1/backups/tasks", {
        method: "PUT",
        headers: { "content-type": "application/json", "x-csrf-token": props.csrfToken },
        body: JSON.stringify({ envelope: encrypted.envelope, expectedVersion: backup?.version || 0 }),
      });
      const stored = await responsePayload<CloudTaskBackupMetadata>(cloudResponse, "无法上传加密备份");
      setBackup(stored);
      setBackupPassphrase("");
      setConfirmation("");
      setMessage(`已加密备份 ${stored.taskCount} 个任务，云端仅保存 ${backupSize(stored.sizeBytes)} 密文。`);
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      await loadStatus();
      setError(detail);
    } finally {
      setBusy("");
    }
  };

  const restoreBackup = async () => {
    setError("");
    setMessage("");
    if (!backup) return setError("当前工作区还没有可恢复的云端备份");
    if (restorePassphrase.length < 12) return setError("请输入创建备份时使用的口令");
    setBusy("restore");
    try {
      const downloadResponse = await cloudRequest("/v1/backups/tasks/download");
      const download = await responsePayload<CloudTaskBackupDownloadPayload>(downloadResponse, "无法下载加密备份");
      const localResponse = await fetch("/api/cloud-backup/tasks/restore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passphrase: restorePassphrase, envelope: download.envelope }),
      });
      const restored = await responsePayload<TaskBackupRestoreResult>(localResponse, "无法在本机恢复任务备份");
      setRestorePassphrase("");
      setMessage(`已恢复 ${restored.imported} 个任务，跳过 ${restored.skipped} 个本机已有版本；没有覆盖现有任务。`);
      await props.onTasksChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  };

  const deleteBackup = async () => {
    if (!backup || !window.confirm("确定永久删除当前账户在这个工作区的云端密文备份吗？本机任务不会删除。")) return;
    setError("");
    setMessage("");
    setBusy("delete");
    try {
      const response = await cloudRequest("/v1/backups/tasks", {
        method: "DELETE",
        headers: { "x-csrf-token": props.csrfToken },
      });
      if (!response.ok) await responsePayload(response, "无法删除云端备份");
      setBackup(null);
      setMessage("云端密文备份已删除，本机任务保持不变。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  };

  const disabled = loading || Boolean(busy) || props.anyTaskRunning;
  return <section className="cloud-backup-shell" aria-labelledby="cloud-backup-title" aria-busy={Boolean(busy) || loading}>
    <div className="cloud-backup-heading">
      <span><LockKeyhole size={17} /></span>
      <div>
        <h4 id="cloud-backup-title">端到端加密任务备份</h4>
        <p>{loading ? "正在读取备份状态…" : backup
          ? `最近备份：${backupTime(backup.createdAt)} · ${backup.taskCount} 个任务 · ${backupSize(backup.sizeBytes)}`
          : "当前账户在这个工作区还没有加密任务备份。"}</p>
      </div>
      {backup && <button className="danger-icon" type="button" disabled={disabled} onClick={() => void deleteBackup()} aria-label="删除云端密文备份" title="删除云端密文备份">
        {busy === "delete" ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}
      </button>}
    </div>

    <div className="cloud-backup-warning" id="cloud-backup-passphrase-help">
      <KeyRound size={15} /><span>口令只在本机用于加解密，Forge Cloud 无法读取或找回。请自行安全保存；忘记口令将无法恢复备份。</span>
    </div>

    <div className="cloud-backup-actions">
      <form onSubmit={(event) => { event.preventDefault(); void createBackup(); }}>
        <strong>备份当前设备</strong>
        <p>备份任务对话、命令输出和 Diff；不包含工作区文件、旧 Agent 会话、等待队列、Skill/MCP 配置或安全存储密钥。</p>
        <label htmlFor="cloud-backup-passphrase">新备份口令</label>
        <input id="cloud-backup-passphrase" type="password" autoComplete="new-password" minLength={12} maxLength={256} value={backupPassphrase} onChange={(event) => setBackupPassphrase(event.target.value)} aria-describedby="cloud-backup-passphrase-help" disabled={disabled} />
        <label htmlFor="cloud-backup-confirmation">再次输入口令</label>
        <input id="cloud-backup-confirmation" type="password" autoComplete="new-password" minLength={12} maxLength={256} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} aria-describedby="cloud-backup-passphrase-help" disabled={disabled} />
        <button type="submit" disabled={disabled || !backupPassphrase || !confirmation}>
          {busy === "backup" ? <LoaderCircle className="spin" size={14} /> : <CloudUpload size={14} />}{busy === "backup" ? "加密上传中…" : backup ? "替换云端备份" : "创建云端备份"}
        </button>
      </form>

      <form onSubmit={(event) => { event.preventDefault(); void restoreBackup(); }}>
        <strong>恢复到当前设备</strong>
        <p>使用创建备份时的口令解密，导入为新的历史任务；不会覆盖、删除或自动执行现有内容。</p>
        <label htmlFor="cloud-restore-passphrase">备份口令</label>
        <input id="cloud-restore-passphrase" type="password" autoComplete="off" minLength={12} maxLength={256} value={restorePassphrase} onChange={(event) => setRestorePassphrase(event.target.value)} aria-describedby="cloud-backup-passphrase-help" disabled={disabled || !backup} />
        <button type="submit" disabled={disabled || !backup || !restorePassphrase}>
          {busy === "restore" ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}{busy === "restore" ? "解密恢复中…" : "恢复任务备份"}
        </button>
      </form>
    </div>

    {props.anyTaskRunning && <div className="cloud-sync-warning">请先停止正在运行的任务，再创建或恢复备份。</div>}
    {(error || message) && <div className={`settings-feedback ${error ? "feedback-error" : "feedback-success"}`} role={error ? "alert" : "status"} aria-live="polite">{error || message}</div>}
  </section>;
}
