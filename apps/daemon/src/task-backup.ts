import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt } from "node:crypto";
import { gzip, gunzip } from "node:zlib";
import type { Activity, EncryptedTaskBackupEnvelope, ForgeIdentityContext, ForgeTask } from "@forge/contracts";

const MAX_ENCRYPTED_BYTES = 8 * 1024 * 1024;
const MAX_PLAINTEXT_BYTES = 32 * 1024 * 1024;
const MAX_TASKS = 2_000;
const SCRYPT_OPTIONS = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface BackupTask {
  sourceTaskId: string;
  title: string;
  subtitle: string;
  pinned: boolean;
  archived: boolean;
  state: "idle" | "completed" | "stopped" | "failed";
  activities: Activity[];
  updatedAt: string;
}

interface TaskBackupPlaintext {
  format: "forge-task-backup-plaintext";
  formatVersion: 1;
  backupId: string;
  tenantId: string;
  userId: string;
  createdAt: string;
  tasks: BackupTask[];
}

function validPassphrase(passphrase: string) {
  if (passphrase.length < 12 || passphrase.length > 256) throw new Error("备份口令应为 12 到 256 个字符");
  return passphrase;
}

function validIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validActivity(value: unknown): value is Activity {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.at !== "string" || typeof value.kind !== "string") return false;
  if (value.kind === "message") return (value.role === "user" || value.role === "assistant") && typeof value.text === "string";
  if (value.kind === "command") return typeof value.command === "string" && typeof value.description === "string"
    && (value.status === "running" || value.status === "passed" || value.status === "failed");
  if (value.kind === "files") return Array.isArray(value.files) && value.files.every((file) => isRecord(file)
    && typeof file.path === "string" && Number.isFinite(file.additions) && Number.isFinite(file.deletions)
    && (file.diff === undefined || typeof file.diff === "string"));
  if (value.kind === "tool") return typeof value.server === "string" && typeof value.tool === "string"
    && (value.status === "running" || value.status === "passed" || value.status === "failed");
  if (value.kind === "notice") return (value.tone === "info" || value.tone === "success" || value.tone === "warning")
    && typeof value.text === "string";
  return false;
}

function safeActivities(activities: Activity[]) {
  return activities.map((activity): Activity => {
    if (activity.kind !== "message" || !activity.contextFiles) return JSON.parse(JSON.stringify(activity)) as Activity;
    const { contextFiles: _localPaths, ...portable } = activity;
    return JSON.parse(JSON.stringify(portable)) as Activity;
  });
}

function backupTask(task: ForgeTask): BackupTask {
  return {
    sourceTaskId: task.id,
    title: task.title,
    subtitle: task.subtitle,
    pinned: Boolean(task.pinned),
    archived: Boolean(task.archived),
    state: task.state === "running" ? "stopped" : task.state,
    activities: safeActivities(task.activities),
    updatedAt: task.updatedAt,
  };
}

function deriveKey(passphrase: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(validPassphrase(passphrase), salt, 32, SCRYPT_OPTIONS, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function gzipAsync(value: Buffer) {
  return new Promise<Buffer>((resolve, reject) => gzip(value, { level: 9 }, (error, result) => error ? reject(error) : resolve(result)));
}

function gunzipAsync(value: Buffer) {
  return new Promise<Buffer>((resolve, reject) => gunzip(value, { maxOutputLength: MAX_PLAINTEXT_BYTES }, (error, result) => error ? reject(error) : resolve(result)));
}

function decodeBase64(value: unknown, label: string, exactBytes?: number) {
  if (typeof value !== "string" || !value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`加密备份的${label}无效`);
  }
  const decoded = Buffer.from(value, "base64");
  if (exactBytes !== undefined && decoded.length !== exactBytes) throw new Error(`加密备份的${label}无效`);
  if (decoded.toString("base64") !== value) throw new Error(`加密备份的${label}无效`);
  return decoded;
}

function envelopeAad(envelope: Pick<EncryptedTaskBackupEnvelope, "createdAt" | "taskCount">, identity: ForgeIdentityContext) {
  return Buffer.from(`forge-task-backup:1:${envelope.createdAt}:${envelope.taskCount}:${identity.tenantId}:${identity.userId}`, "utf8");
}

export function validateEncryptedEnvelope(value: unknown): EncryptedTaskBackupEnvelope {
  if (!isRecord(value) || value.format !== "forge-task-backup" || value.formatVersion !== 1
    || value.encryption !== "aes-256-gcm" || value.compression !== "gzip" || value.keyDerivation !== "scrypt"
    || !validIsoTimestamp(value.createdAt) || !Number.isSafeInteger(value.taskCount) || Number(value.taskCount) < 0 || Number(value.taskCount) > MAX_TASKS) {
    throw new Error("加密任务备份格式无效");
  }
  decodeBase64(value.salt, "盐值", 16);
  decodeBase64(value.iv, "随机向量", 12);
  decodeBase64(value.authTag, "认证标签", 16);
  const ciphertext = decodeBase64(value.ciphertext, "密文");
  if (ciphertext.length > MAX_ENCRYPTED_BYTES) throw new Error("加密任务备份超过 8MB 限制");
  return value as unknown as EncryptedTaskBackupEnvelope;
}

export async function createEncryptedTaskBackup(tasks: ForgeTask[], identity: ForgeIdentityContext, passphrase: string) {
  if (identity.mode !== "cloud") throw new Error("加密云备份只在 Cloud 工作区中可用");
  if (tasks.length > MAX_TASKS) throw new Error("单次最多备份 2000 个任务");
  const createdAt = new Date().toISOString();
  const plaintext: TaskBackupPlaintext = {
    format: "forge-task-backup-plaintext",
    formatVersion: 1,
    backupId: randomUUID(),
    tenantId: identity.tenantId,
    userId: identity.userId,
    createdAt,
    tasks: tasks.map(backupTask),
  };
  const serialized = Buffer.from(JSON.stringify(plaintext), "utf8");
  if (serialized.length > MAX_PLAINTEXT_BYTES) throw new Error("任务内容超过 32MB 备份限制");
  const compressed = await gzipAsync(serialized);
  if (compressed.length > MAX_ENCRYPTED_BYTES) throw new Error("压缩后的任务内容超过 8MB 备份限制");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const envelope: EncryptedTaskBackupEnvelope = {
    format: "forge-task-backup",
    formatVersion: 1,
    encryption: "aes-256-gcm",
    compression: "gzip",
    keyDerivation: "scrypt",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    authTag: "",
    ciphertext: "",
    createdAt,
    taskCount: plaintext.tasks.length,
  };
  const key = await deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(envelopeAad(envelope, identity));
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  envelope.authTag = cipher.getAuthTag().toString("base64");
  envelope.ciphertext = ciphertext.toString("base64");
  return { envelope, plaintextBytes: serialized.length, encryptedBytes: ciphertext.length };
}

export async function decryptTaskBackup(value: unknown, identity: ForgeIdentityContext, passphrase: string): Promise<TaskBackupPlaintext> {
  if (identity.mode !== "cloud") throw new Error("加密云备份只在 Cloud 工作区中可用");
  const envelope = validateEncryptedEnvelope(value);
  try {
    const salt = decodeBase64(envelope.salt, "盐值", 16);
    const key = await deriveKey(passphrase, salt);
    const decipher = createDecipheriv("aes-256-gcm", key, decodeBase64(envelope.iv, "随机向量", 12));
    decipher.setAAD(envelopeAad(envelope, identity));
    decipher.setAuthTag(decodeBase64(envelope.authTag, "认证标签", 16));
    const compressed = Buffer.concat([decipher.update(decodeBase64(envelope.ciphertext, "密文")), decipher.final()]);
    const plaintextBuffer = await gunzipAsync(compressed);
    const parsed = JSON.parse(plaintextBuffer.toString("utf8")) as unknown;
    if (!isRecord(parsed) || parsed.format !== "forge-task-backup-plaintext" || parsed.formatVersion !== 1
      || !uuidPattern.test(String(parsed.backupId || "")) || parsed.tenantId !== identity.tenantId || parsed.userId !== identity.userId
      || parsed.createdAt !== envelope.createdAt || !Array.isArray(parsed.tasks) || parsed.tasks.length !== envelope.taskCount) {
      throw new Error("加密任务备份内容无效");
    }
    const validStates = new Set(["idle", "completed", "stopped", "failed"]);
    const tasks = parsed.tasks.map((task): BackupTask => {
      if (!isRecord(task) || !uuidPattern.test(String(task.sourceTaskId || "")) || typeof task.title !== "string" || !task.title.trim() || task.title.length > 80
        || typeof task.subtitle !== "string" || task.subtitle.length > 200 || !validStates.has(String(task.state))
        || typeof task.pinned !== "boolean" || typeof task.archived !== "boolean" || !validIsoTimestamp(task.updatedAt)
        || !Array.isArray(task.activities) || !task.activities.every(validActivity)) throw new Error("加密任务备份包含无效任务");
      return task as unknown as BackupTask;
    });
    return { ...parsed, tasks } as unknown as TaskBackupPlaintext;
  } catch (error) {
    if (error instanceof Error && /备份口令应为/.test(error.message)) throw error;
    throw new Error("备份口令错误、租户不匹配或备份数据已损坏");
  }
}
