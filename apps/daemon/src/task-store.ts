import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Activity, ForgeIdentityContext, ForgeTask, QueuedTurn } from "@forge/contracts";

interface PersistedState {
  schemaVersion: number;
  tenantId: string;
  userId: string;
  workspacePath: string;
  tasks: ForgeTask[];
}

const now = () => new Date().toISOString();

const localIdentity: ForgeIdentityContext = { tenantId: "local", userId: "local", mode: "local" };

export function tenantStorageKey(tenantId: string) {
  return createHash("sha256").update(tenantId).digest("hex").slice(0, 24);
}

function seedState(workspacePath: string, identity: ForgeIdentityContext): PersistedState {
  return {
    schemaVersion: 3,
    tenantId: identity.tenantId,
    userId: identity.userId,
    workspacePath,
    tasks: [],
  };
}

export class TaskStore {
  private state: PersistedState;
  private readonly filePath: string;
  private persistQueue = Promise.resolve();

  constructor(private readonly defaultWorkspacePath: string, private readonly identity: ForgeIdentityContext = localIdentity) {
    this.state = seedState(defaultWorkspacePath, identity);
    const dataDir = process.env.FORGE_DATA_DIR || path.join(os.homedir(), ".forge");
    this.filePath = identity.mode === "local"
      ? path.join(dataDir, "state.json")
      : path.join(dataDir, "tenants", tenantStorageKey(identity.tenantId), "state.json");
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
    const migratingToIsolatedRuntime = loaded.schemaVersion !== 2 && loaded.schemaVersion !== 3;
    this.state = {
      schemaVersion: 3,
      tenantId: this.identity.tenantId,
      userId: this.identity.userId,
      workspacePath,
      tasks: (loaded.tasks || []).map((task) => {
        const migrated: ForgeTask = {
          ...task,
          tenantId: this.identity.tenantId,
          userId: loaded.schemaVersion === 3 && task.userId ? task.userId : this.identity.userId,
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
    };
    await this.persist();
  }

  private parseState(serialized: string): Partial<PersistedState> {
    const parsed = JSON.parse(serialized) as Partial<PersistedState>;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.tasks)) throw new Error("Forge 任务数据格式无效");
    return parsed;
  }

  private assertStoredIdentity(state: Partial<PersistedState>) {
    if (this.identity.mode === "cloud" && state.schemaVersion === 3 && state.tenantId !== this.identity.tenantId) {
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
