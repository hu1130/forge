import type {
  CloudTaskBackupMetadata, EncryptedTaskBackupEnvelope,
} from "@forge/contracts";
import type { TenantPrincipal } from "./tenant-resources.js";

export const MAX_ENCRYPTED_TASK_BACKUP_BYTES = 8 * 1024 * 1024;

export interface StoredEncryptedTaskBackup extends CloudTaskBackupMetadata {
  envelope: EncryptedTaskBackupEnvelope;
}

export interface EncryptedBackupStore {
  getTaskBackup(principal: TenantPrincipal): Promise<StoredEncryptedTaskBackup | undefined>;
  upsertTaskBackup(principal: TenantPrincipal, input: {
    envelope: EncryptedTaskBackupEnvelope;
    sizeBytes: number;
    expectedVersion?: number;
  }): Promise<StoredEncryptedTaskBackup>;
  deleteTaskBackup(principal: TenantPrincipal): Promise<boolean>;
}

export class EncryptedBackupVersionConflictError extends Error {
  constructor(readonly current?: CloudTaskBackupMetadata) {
    super("云端备份已被其他设备更新，请刷新后重试");
  }
}

export function backupMetadata(backup: StoredEncryptedTaskBackup): CloudTaskBackupMetadata {
  return {
    version: backup.version,
    sizeBytes: backup.sizeBytes,
    taskCount: backup.taskCount,
    createdAt: backup.createdAt,
    updatedAt: backup.updatedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function decodeBase64(value: unknown, exactBytes?: number) {
  if (typeof value !== "string" || !value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error("加密任务备份包含无效编码");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || (exactBytes !== undefined && decoded.length !== exactBytes)) {
    throw new Error("加密任务备份包含无效编码");
  }
  return decoded;
}

export function validateEncryptedTaskBackup(value: unknown) {
  if (!isRecord(value) || value.format !== "forge-task-backup" || value.formatVersion !== 1
    || value.encryption !== "aes-256-gcm" || value.compression !== "gzip" || value.keyDerivation !== "scrypt"
    || !validIsoTimestamp(value.createdAt) || !Number.isSafeInteger(value.taskCount)
    || Number(value.taskCount) < 0 || Number(value.taskCount) > 2_000) {
    throw new Error("加密任务备份格式无效");
  }
  decodeBase64(value.salt, 16);
  decodeBase64(value.iv, 12);
  decodeBase64(value.authTag, 16);
  const ciphertext = decodeBase64(value.ciphertext);
  if (ciphertext.length > MAX_ENCRYPTED_TASK_BACKUP_BYTES) throw new Error("加密任务备份超过 8MB 限制");
  const envelope = JSON.parse(JSON.stringify(value)) as EncryptedTaskBackupEnvelope;
  return { envelope, sizeBytes: ciphertext.length };
}
