import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  Activity, CloudTaskMetadata, EncryptedTaskBackupEnvelope, ForgeIdentityContext, ForgeTask, LocalProfileImportResult,
  LocalProfileSummary, QueuedTurn, TaskBackupCreateResult, TaskBackupRestoreResult, TaskSyncReceipt, TaskSyncSnapshot,
  WorkspacePreferences,
} from "@forge/contracts";
import { createEncryptedTaskBackup, decryptTaskBackup } from "./task-backup.js";

interface PersistedState {
  schemaVersion: number;
  tenantId: string;
  userId: string;
  workspacePath: string;
  preferences: WorkspacePreferences;
  tasks: ForgeTask[];
  taskSyncReceipts: Record<string, TaskSyncReceipt>;
}

const now = () => new Date().toISOString();

function validIsoTimestamp(value: string) {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

const localIdentity: ForgeIdentityContext = { tenantId: "local", userId: "local", mode: "local" };
const defaultPreferences: WorkspacePreferences = {
  defaultProviderId: "deepseek",
  approvalPolicy: "untrusted",
  rememberInspectorTab: true,
  defaultInspectorTab: "changes",
};

export function tenantStorageKey(tenantId: string) {
  return createHash("sha256").update(tenantId).digest("hex").slice(0, 24);
}

function seedState(workspacePath: string, identity: ForgeIdentityContext): PersistedState {
  return {
    schemaVersion: 5,
    tenantId: identity.tenantId,
    userId: identity.userId,
    workspacePath,
    preferences: { ...defaultPreferences },
    tasks: [],
    taskSyncReceipts: {},
  };
}

export class TaskStore {
  private state: PersistedState;
  private readonly filePath: string;
  private readonly dataDir: string;
  private persistQueue = Promise.resolve();

  constructor(private readonly defaultWorkspacePath: string, private readonly identity: ForgeIdentityContext = localIdentity) {
    this.state = seedState(defaultWorkspacePath, identity);
    this.dataDir = process.env.FORGE_DATA_DIR || path.join(os.homedir(), ".forge");
    this.filePath = identity.mode === "local"
      ? path.join(this.dataDir, "state.json")
      : path.join(this.dataDir, "tenants", tenantStorageKey(identity.tenantId), "state.json");
  }

  async load() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    let loaded: Partial<PersistedState>;
    try {
      loaded = this.parseState(await readFile(this.filePath, "utf8"));
      this.assertStoredIdentity(loaded);
    } catch (error) {
      if (this.errorCode(error) === "ENOENT") {
        await this.persist();
        return;
      }
      const quarantinedPath = `${this.filePath}.corrupt-${Date.now()}-${randomUUID()}.json`;
      await rename(this.filePath, quarantinedPath);
      try {
        loaded = this.parseState(await readFile(`${this.filePath}.bak`, "utf8"));
        this.assertStoredIdentity(loaded);
      } catch (backupError) {
        if (this.errorCode(backupError) !== "ENOENT") {
          const backupPath = `${this.filePath}.bak.corrupt-${Date.now()}-${randomUUID()}.json`;
          await rename(`${this.filePath}.bak`, backupPath);
        }
        loaded = seedState(this.defaultWorkspacePath, this.identity);
      }
    }

    const workspacePath = loaded.workspacePath || this.defaultWorkspacePath;
    const migratingToIsolatedRuntime = ![2, 3, 4, 5].includes(loaded.schemaVersion || 0);
    this.state = {
      schemaVersion: 5,
      tenantId: this.identity.tenantId,
      userId: this.identity.userId,
      workspacePath,
      preferences: this.validPreferences(loaded.preferences) ? { ...loaded.preferences } : { ...defaultPreferences },
      tasks: (loaded.tasks || []).map((task) => {
        const migrated: ForgeTask = {
          ...task,
          tenantId: this.identity.tenantId,
          userId: (loaded.schemaVersion || 0) >= 3 && task.userId ? task.userId : this.identity.userId,
          workspacePath: task.workspacePath || workspacePath,
          queuedTurns: task.queuedTurns || [],
        };
        if (migratingToIsolatedRuntime && migrated.agentSession) {
          delete migrated.agentSession;
          migrated.activities = [...migrated.activities, {
            id: randomUUID(),
            kind: "notice",
            tone: "info",
            text: "Forge 已切换到独立扩展运行时。历史记录仍然保留，下一条消息会建立新的模型会话。",
            at: now(),
          }];
        }
        if (migrated.state === "running") {
          migrated.state = "stopped";
          migrated.activities = [...migrated.activities, {
            id: randomUUID(),
            kind: "notice",
            tone: "warning",
            text: "Forge 上次运行意外中断，此任务已安全停止，可以重新发送需求继续。",
            at: now(),
          }];
        }
        return migrated;
      }),
      taskSyncReceipts: loaded.taskSyncReceipts && typeof loaded.taskSyncReceipts === "object"
        ? loaded.taskSyncReceipts
        : {},
    };
    await this.persist();
  }

  private parseState(serialized: string): Partial<PersistedState> {
    const parsed = JSON.parse(serialized) as Partial<PersistedState>;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.tasks)) throw new Error("Forge 任务数据格式无效");
    return parsed;
  }

  private assertStoredIdentity(state: Partial<PersistedState>) {
    if (this.identity.mode === "cloud" && (state.schemaVersion || 0) >= 3 && state.tenantId !== this.identity.tenantId) {
      throw new Error("Forge 租户任务数据身份不匹配");
    }
  }

  private errorCode(error: unknown) {
    return error && typeof error === "object" && "code" in error ? String(error.code) : "";
  }

  list(workspacePath?: string) {
    const tasks = workspacePath ? this.state.tasks.filter((task) => task.workspacePath === workspacePath) : this.state.tasks;
    return [...tasks].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt.localeCompare(a.updatedAt));
  }

  workspace() {
    return this.state.workspacePath;
  }

  identityContext() {
    return { ...this.identity };
  }

  preferences() {
    return { ...this.state.preferences };
  }

  async updatePreferences(patch: Partial<WorkspacePreferences>) {
    const allowedKeys = new Set(["defaultProviderId", "approvalPolicy", "rememberInspectorTab", "defaultInspectorTab"]);
    if (Object.keys(patch).some((key) => !allowedKeys.has(key))) throw new Error("工作区偏好设置包含未知字段");
    const next = { ...this.state.preferences, ...patch };
    if (!this.validPreferences(next)) throw new Error("工作区偏好设置无效");
    this.state.preferences = next;
    await this.persist();
    return this.preferences();
  }

  private validPreferences(value: unknown): value is WorkspacePreferences {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<WorkspacePreferences>;
    return (candidate.defaultProviderId === "demo" || candidate.defaultProviderId === "deepseek")
      && (candidate.approvalPolicy === "untrusted" || candidate.approvalPolicy === "on-request")
      && typeof candidate.rememberInspectorTab === "boolean"
      && (candidate.defaultInspectorTab === "changes" || candidate.defaultInspectorTab === "terminal" || candidate.defaultInspectorTab === "git");
  }

  private async readLocalProfile() {
    try {
      return this.parseState(await readFile(path.join(this.dataDir, "state.json"), "utf8"));
    } catch (error) {
      if (this.errorCode(error) === "ENOENT") return undefined;
      throw new Error("本机免登录资料无法读取，请先检查数据文件");
    }
  }

  private summarizeLocalProfile(local: Partial<PersistedState> | undefined): LocalProfileSummary {
    const localTasks = local?.tasks || [];
    const importedIds = new Set(this.state.tasks
      .map((task) => task.importedFrom?.profile === "local" ? task.importedFrom.taskId : undefined)
      .filter((value): value is string => Boolean(value)));
    const alreadyImported = localTasks.filter((task) => importedIds.has(task.id)).length;
    return {
      available: Boolean(local),
      totalTasks: localTasks.length,
      eligibleTasks: localTasks.length - alreadyImported,
      alreadyImported,
    };
  }

  async localProfileSummary() {
    if (this.identity.mode !== "cloud") throw new Error("本机资料导入只在 Cloud 租户中可用");
    return this.summarizeLocalProfile(await this.readLocalProfile());
  }

  async importLocalProfile(): Promise<LocalProfileImportResult> {
    if (this.identity.mode !== "cloud") throw new Error("本机资料导入只在 Cloud 租户中可用");
    const local = await this.readLocalProfile();
    const before = this.summarizeLocalProfile(local);
    if (!local?.tasks?.length || !before.eligibleTasks) {
      return { imported: 0, skipped: before.alreadyImported, tasks: this.list(), summary: before };
    }

    const importedIds = new Set(this.state.tasks
      .map((task) => task.importedFrom?.profile === "local" ? task.importedFrom.taskId : undefined)
      .filter((value): value is string => Boolean(value)));
    const importedAt = now();
    const importedTasks = local.tasks.filter((task) => !importedIds.has(task.id)).map((task): ForgeTask => {
      const state = (["idle", "completed", "stopped", "failed"] as const).includes(task.state as "idle") ? task.state : "stopped";
      return {
        id: randomUUID(),
        tenantId: this.identity.tenantId,
        userId: this.identity.userId,
        title: task.title || "导入的本机任务",
        subtitle: task.subtitle || "从本机资料导入",
        workspacePath: task.workspacePath || local.workspacePath || this.state.workspacePath,
        pinned: Boolean(task.pinned),
        archived: Boolean(task.archived),
        state,
        activities: [
          ...(Array.isArray(task.activities) ? task.activities : []),
          {
            id: randomUUID(),
            kind: "notice",
            tone: "info",
            text: "此任务由用户主动从本机免登录资料导入；模型会话和等待队列没有迁移。",
            at: importedAt,
          },
        ],
        queuedTurns: [],
        importedFrom: { profile: "local", taskId: task.id, importedAt },
        updatedAt: importedAt,
      };
    });
    this.state.tasks.unshift(...importedTasks);
    await this.persist();
    const summary = this.summarizeLocalProfile(local);
    return { imported: importedTasks.length, skipped: summary.alreadyImported, tasks: this.list(), summary };
  }

  async createEncryptedBackup(passphrase: string): Promise<TaskBackupCreateResult> {
    return await createEncryptedTaskBackup(this.list(), this.identity, passphrase);
  }

  async restoreEncryptedBackup(envelope: EncryptedTaskBackupEnvelope, passphrase: string): Promise<TaskBackupRestoreResult> {
    const backup = await decryptTaskBackup(envelope, this.identity, passphrase);
    const restoredAt = now();
    const restoredTasks: ForgeTask[] = [];
    let skipped = 0;
    for (const source of backup.tasks) {
      const originalStillExists = this.state.tasks.some((task) => task.id === source.sourceTaskId);
      const restoredVersionExists = this.state.tasks.some((task) => task.restoredFrom?.taskId === source.sourceTaskId
        && task.restoredFrom.taskUpdatedAt >= source.updatedAt);
      if (originalStillExists || restoredVersionExists) {
        skipped += 1;
        continue;
      }
      restoredTasks.push({
        id: randomUUID(),
        tenantId: this.identity.tenantId,
        userId: this.identity.userId,
        title: source.title,
        subtitle: "从加密云备份恢复",
        workspacePath: this.state.workspacePath,
        pinned: source.pinned,
        archived: source.archived,
        state: source.state,
        activities: [
          ...source.activities.map((activity): Activity => activity.kind === "files" ? { ...activity, portableOnly: true } : activity),
          {
            id: randomUUID(),
            kind: "notice",
            tone: "info",
            text: "此任务由端到端加密云备份恢复。旧 Agent 会话、等待队列和原设备工作区路径未恢复，代码变更记录仅供查看。",
            at: restoredAt,
          },
        ],
        queuedTurns: [],
        restoredFrom: { backupId: backup.backupId, taskId: source.sourceTaskId, taskUpdatedAt: source.updatedAt, restoredAt },
        updatedAt: restoredAt,
      });
    }
    if (restoredTasks.length) {
      this.state.tasks.unshift(...restoredTasks);
      await this.persist();
    }
    return { imported: restoredTasks.length, skipped, tasks: this.list() };
  }

  taskSyncSnapshot(): TaskSyncSnapshot {
    return { tasks: this.list(), receipts: { ...this.state.taskSyncReceipts } };
  }

  async recordTaskSync(taskId: string, receipt: TaskSyncReceipt) {
    const task = this.find(taskId);
    if (!task) throw new Error("任务不存在");
    if (!Number.isSafeInteger(receipt.resourceVersion) || receipt.resourceVersion < 1 || task.updatedAt !== receipt.taskUpdatedAt) {
      throw new Error("任务已发生变化，请重新同步");
    }
    this.state.taskSyncReceipts[taskId] = { ...receipt };
    await this.persist();
    return this.taskSyncSnapshot();
  }

  async applyCloudTaskMetadata(taskId: string, metadata: CloudTaskMetadata, expectedLocalUpdatedAt: string, resourceVersion: number) {
    const task = this.find(taskId);
    if (!task) throw new Error("任务不存在");
    if (task.state === "running") throw new Error("请先停止任务，再应用云端目录信息");
    if (task.updatedAt !== expectedLocalUpdatedAt) throw new Error("本机任务已发生变化，请重新同步");
    if (!metadata.title.trim() || metadata.title.trim().length > 80 || !validIsoTimestamp(metadata.updatedAt)) {
      throw new Error("云端任务目录信息无效");
    }
    if (!Number.isSafeInteger(resourceVersion) || resourceVersion < 1) throw new Error("云端任务版本无效");
    task.title = metadata.title.trim();
    task.pinned = metadata.pinned;
    task.archived = metadata.archived;
    task.updatedAt = metadata.updatedAt;
    this.state.taskSyncReceipts[taskId] = { resourceVersion, taskUpdatedAt: metadata.updatedAt };
    await this.persist();
    return task;
  }

  async setWorkspace(workspacePath: string) {
    this.state.workspacePath = workspacePath;
    await this.persist();
  }

  find(id: string) {
    return this.state.tasks.find((task) => task.id === id);
  }

  async create(title = "新任务", workspacePath = this.state.workspacePath) {
    const task: ForgeTask = {
      id: randomUUID(),
      tenantId: this.identity.tenantId,
      userId: this.identity.userId,
      title,
      subtitle: "尚未开始",
      workspacePath,
      state: "idle",
      activities: [],
      queuedTurns: [],
      updatedAt: now(),
    };
    this.state.tasks.unshift(task);
    await this.persist();
    return task;
  }

  async addActivity(id: string, activity: Activity) {
    const task = this.find(id);
    if (!task) return null;
    const existingIndex = task.activities.findIndex((item) => item.id === activity.id);
    if (existingIndex >= 0) task.activities[existingIndex] = activity;
    else task.activities.push(activity);
    if (task.title === "新任务" && activity.kind === "message" && activity.role === "user") {
      task.title = activity.text.length > 24 ? `${activity.text.slice(0, 24)}…` : activity.text;
    }
    task.updatedAt = now();
    task.subtitle = "刚刚更新";
    await this.persist();
    return task;
  }

  async setState(id: string, state: ForgeTask["state"]) {
    const task = this.find(id);
    if (!task) return null;
    task.state = state;
    task.updatedAt = now();
    await this.persist();
    return task;
  }

  async setAgentSession(id: string, agentSession: NonNullable<ForgeTask["agentSession"]>) {
    const task = this.find(id);
    if (!task) return null;
    task.agentSession = agentSession;
    task.updatedAt = now();
    await this.persist();
    return task;
  }

  async addQueuedTurn(id: string, queuedTurn: QueuedTurn) {
    const task = this.find(id);
    if (!task) return null;
    task.queuedTurns = [...(task.queuedTurns || []), queuedTurn];
    task.updatedAt = now();
    task.subtitle = `${task.queuedTurns.length} 条等待执行`;
    await this.persist();
    return [...task.queuedTurns];
  }

  async removeQueuedTurn(id: string, queuedTurnId: string) {
    const task = this.find(id);
    if (!task) return null;
    task.queuedTurns = (task.queuedTurns || []).filter((item) => item.id !== queuedTurnId);
    task.updatedAt = now();
    if (task.queuedTurns.length) task.subtitle = `${task.queuedTurns.length} 条等待执行`;
    await this.persist();
    return [...task.queuedTurns];
  }

  async reorderQueuedTurns(id: string, queuedTurnIds: string[]) {
    const task = this.find(id);
    if (!task) return null;
    const current = task.queuedTurns || [];
    const byId = new Map(current.map((item) => [item.id, item]));
    if (queuedTurnIds.length !== current.length || new Set(queuedTurnIds).size !== current.length || queuedTurnIds.some((itemId) => !byId.has(itemId))) {
      throw new Error("队列顺序与当前任务不一致，请刷新后重试");
    }
    task.queuedTurns = queuedTurnIds.map((itemId) => byId.get(itemId) as QueuedTurn);
    task.updatedAt = now();
    await this.persist();
    return [...task.queuedTurns];
  }

  async update(id: string, patch: { title?: string; pinned?: boolean; archived?: boolean }) {
    const task = this.find(id);
    if (!task) return null;
    if (patch.title !== undefined) task.title = patch.title;
    if (patch.pinned !== undefined) task.pinned = patch.pinned;
    if (patch.archived !== undefined) task.archived = patch.archived;
    task.updatedAt = now();
    await this.persist();
    return task;
  }

  async markFileActivities(id: string, activityIds: string[], reverted: boolean) {
    const task = this.find(id);
    if (!task) return null;
    const ids = new Set(activityIds);
    const changedAt = now();
    for (const activity of task.activities) {
      if (activity.kind !== "files" || !ids.has(activity.id)) continue;
      if (reverted) activity.revertedAt = changedAt;
      else delete activity.revertedAt;
    }
    task.updatedAt = changedAt;
    task.subtitle = reverted ? "代码变更已撤销" : "代码变更已重新应用";
    await this.persist();
    return task;
  }

  async delete(id: string) {
    const index = this.state.tasks.findIndex((task) => task.id === id);
    if (index < 0) return false;
    this.state.tasks.splice(index, 1);
    await this.persist();
    return true;
  }

  private async persist() {
    const snapshot = JSON.stringify(this.state, null, 2);
    const write = this.persistQueue.then(async () => {
      const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await copyFile(this.filePath, `${this.filePath}.bak`);
      } catch (error) {
        if (this.errorCode(error) !== "ENOENT") throw error;
      }
      await writeFile(temporary, snapshot, "utf8");
      await rename(temporary, this.filePath);
    });
    this.persistQueue = write.catch(() => undefined);
    await write;
  }
}
