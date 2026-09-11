import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createPool, type Pool, type PoolConnection, type ResultSetHeader, type RowDataPacket } from "mysql2/promise";
import type { CloudTenantResource, CloudTenantResourceKind } from "@forge/contracts";
import {
  DuplicateEmailError, type AuthActionPurpose, type AuthStore, type StoredSession,
  type StoredSessionSummary, type StoredUser,
} from "./auth-service.js";
import { TenantAccessError, TenantVersionConflictError, type TenantPrincipal, type TenantResourceStore } from "./tenant-resources.js";

interface SessionRow extends RowDataPacket {
  session_id: string;
  token_hash: string;
  csrf_token: string;
  session_created_at: Date;
  expires_at: Date;
  user_id: string;
  email: string;
  display_name: string;
  email_verified_at: Date | null;
  disabled_at: Date | null;
  tenant_id: string;
  tenant_name: string;
  tenant_slug: string;
  role: "owner" | "admin" | "member";
}

interface UserRow extends RowDataPacket {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  email_verified_at: Date | null;
  disabled_at: Date | null;
}

interface TenantResourceRow extends RowDataPacket {
  kind: CloudTenantResourceKind;
  resource_key: string;
  owner_user_id: string;
  updated_by_user_id: string;
  payload: Record<string, unknown> | string;
  version: string | number;
  created_at: Date;
  updated_at: Date;
}

interface IdRow extends RowDataPacket { id: string }
interface UserIdRow extends RowDataPacket { id: string; user_id: string }
interface MigrationRow extends RowDataPacket { name: string }
interface LockRow extends RowDataPacket { acquired: number | string | null }

function parsePayload(payload: Record<string, unknown> | string): Record<string, unknown> {
  return typeof payload === "string" ? JSON.parse(payload) as Record<string, unknown> : payload;
}

function mapTenantResource(row: TenantResourceRow): CloudTenantResource {
  return {
    kind: row.kind,
    key: row.resource_key,
    ownerUserId: row.owner_user_id,
    updatedByUserId: row.updated_by_user_id,
    payload: parsePayload(row.payload),
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapSession(row: SessionRow): StoredSession {
  return {
    id: row.session_id,
    tokenHash: row.token_hash,
    csrfToken: row.csrf_token,
    createdAt: row.session_created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    user: {
      id: row.user_id,
      email: row.email,
      displayName: row.display_name,
      ...(row.email_verified_at ? { emailVerifiedAt: row.email_verified_at.toISOString() } : {}),
      ...(row.disabled_at ? { disabledAt: row.disabled_at.toISOString() } : {}),
    },
    tenant: { id: row.tenant_id, name: row.tenant_name, slug: row.tenant_slug },
    role: row.role,
  };
}

const SESSION_QUERY = `
  SELECT s.id AS session_id, s.token_hash, s.csrf_token, s.created_at AS session_created_at, s.expires_at,
         u.id AS user_id, u.email, u.display_name, u.email_verified_at, u.disabled_at,
         t.id AS tenant_id, t.name AS tenant_name, t.slug AS tenant_slug,
         m.role
    FROM forge_sessions s
    JOIN forge_users u ON u.id = s.user_id
    JOIN forge_tenants t ON t.id = s.tenant_id
    JOIN forge_tenant_memberships m ON m.tenant_id = s.tenant_id AND m.user_id = s.user_id
`;

const RESOURCE_COLUMNS = "kind, resource_key, owner_user_id, updated_by_user_id, payload, version, created_at, updated_at";

export function createForgeMySqlPool(uri: string, connectionLimit: number) {
  const pool = createPool({ uri, connectionLimit, timezone: "Z" });
  pool.pool.on("connection", (connection) => {
    connection.query("SET time_zone = '+00:00'", (error) => {
      if (error) connection.destroy();
    });
  });
  return pool;
}

export class MySqlAuthStore implements AuthStore, TenantResourceStore {
  constructor(readonly pool: Pool) {}

  async createAccount(input: { userId: string; tenantId: string; email: string; displayName: string; passwordHash: string; emailVerifiedAt?: string; tenantName: string; tenantSlug: string }) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        "INSERT INTO forge_users (id, email, display_name, password_hash, email_verified_at) VALUES (?, ?, ?, ?, ?)",
        [input.userId, input.email, input.displayName, input.passwordHash, input.emailVerifiedAt ? new Date(input.emailVerifiedAt) : null],
      );
      await connection.execute(
        "INSERT INTO forge_tenants (id, name, slug, kind) VALUES (?, ?, ?, 'personal')",
        [input.tenantId, input.tenantName, input.tenantSlug],
      );
      await connection.execute(
        "INSERT INTO forge_tenant_memberships (tenant_id, user_id, role) VALUES (?, ?, 'owner')",
        [input.tenantId, input.userId],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      if (typeof error === "object" && error && "code" in error && error.code === "ER_DUP_ENTRY") {
        throw new DuplicateEmailError("该邮箱已经注册");
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  async findUserByEmail(email: string): Promise<StoredUser | undefined> {
    const [rows] = await this.pool.execute<UserRow[]>(
      "SELECT id, email, display_name, password_hash, email_verified_at, disabled_at FROM forge_users WHERE email = ?",
      [email],
    );
    return rows[0] ? this.mapUser(rows[0]) : undefined;
  }

  async findUserById(userId: string): Promise<StoredUser | undefined> {
    const [rows] = await this.pool.execute<UserRow[]>(
      "SELECT id, email, display_name, password_hash, email_verified_at, disabled_at FROM forge_users WHERE id = ?",
      [userId],
    );
    return rows[0] ? this.mapUser(rows[0]) : undefined;
  }

  private mapUser(row: UserRow): StoredUser {
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      passwordHash: row.password_hash,
      ...(row.email_verified_at ? { emailVerifiedAt: row.email_verified_at.toISOString() } : {}),
      ...(row.disabled_at ? { disabledAt: row.disabled_at.toISOString() } : {}),
    };
  }

  async findDefaultTenant(userId: string) {
    const [rows] = await this.pool.execute<IdRow[]>(`
      SELECT t.id
        FROM forge_tenant_memberships m
        JOIN forge_tenants t ON t.id = m.tenant_id
       WHERE m.user_id = ? AND m.status = 'active'
       ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.created_at
       LIMIT 1
    `, [userId]);
    return rows[0];
  }

  async createSession(input: { id: string; userId: string; tenantId: string; tokenHash: string; csrfToken: string; expiresAt: string }) {
    await this.pool.execute(
      "INSERT INTO forge_sessions (id, user_id, tenant_id, token_hash, csrf_token, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      [input.id, input.userId, input.tenantId, input.tokenHash, input.csrfToken, new Date(input.expiresAt)],
    );
    const session = await this.sessionByHash(input.tokenHash);
    if (!session) throw new Error("创建会话后无法读取账户上下文");
    return session;
  }

  private async sessionByHash(tokenHash: string) {
    const [rows] = await this.pool.execute<SessionRow[]>(
      `${SESSION_QUERY} WHERE s.token_hash = ? AND s.revoked_at IS NULL AND m.status = 'active'`,
      [tokenHash],
    );
    return rows[0] ? mapSession(rows[0]) : undefined;
  }

  async findSession(tokenHash: string) {
    return this.sessionByHash(tokenHash);
  }

  async revokeSession(tokenHash: string) {
    await this.pool.execute("UPDATE forge_sessions SET revoked_at = CURRENT_TIMESTAMP(3) WHERE token_hash = ? AND revoked_at IS NULL", [tokenHash]);
  }

  async createActionToken(input: { id: string; userId: string; purpose: AuthActionPurpose; tokenHash: string; expiresAt: string }) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute("SELECT id FROM forge_users WHERE id = ? FOR UPDATE", [input.userId]);
      await connection.execute(
        "UPDATE forge_auth_action_tokens SET consumed_at = CURRENT_TIMESTAMP(3) WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL",
        [input.userId, input.purpose],
      );
      await connection.execute(
        "INSERT INTO forge_auth_action_tokens (id, user_id, purpose, token_hash, expires_at) VALUES (?, ?, ?, ?, ?)",
        [input.id, input.userId, input.purpose, input.tokenHash, new Date(input.expiresAt)],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  async verifyEmailWithToken(actionTokenHash: string) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const userId = await this.claimActionToken(connection, actionTokenHash, "verify_email");
      if (!userId) {
        await connection.commit();
        return undefined;
      }
      await connection.execute(
        "UPDATE forge_users SET email_verified_at = COALESCE(email_verified_at, CURRENT_TIMESTAMP(3)) WHERE id = ?",
        [userId],
      );
      const [rows] = await connection.execute<UserRow[]>(
        "SELECT id, email, display_name, password_hash, email_verified_at, disabled_at FROM forge_users WHERE id = ?",
        [userId],
      );
      await connection.commit();
      return rows[0] ? this.mapUser(rows[0]) : undefined;
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  async resetPasswordWithToken(actionTokenHash: string, passwordHash: string) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const userId = await this.claimActionToken(connection, actionTokenHash, "reset_password");
      if (!userId) {
        await connection.commit();
        return false;
      }
      await connection.execute("UPDATE forge_users SET password_hash = ? WHERE id = ?", [passwordHash, userId]);
      await connection.execute(
        "UPDATE forge_sessions SET revoked_at = CURRENT_TIMESTAMP(3) WHERE user_id = ? AND revoked_at IS NULL",
        [userId],
      );
      await connection.commit();
      return true;
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  private async claimActionToken(connection: PoolConnection, tokenHash: string, purpose: AuthActionPurpose) {
    const [rows] = await connection.execute<UserIdRow[]>(`
      SELECT id, user_id
        FROM forge_auth_action_tokens
       WHERE token_hash = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > CURRENT_TIMESTAMP(3)
       FOR UPDATE
    `, [tokenHash, purpose]);
    if (!rows[0]) return undefined;
    await connection.execute(
      "UPDATE forge_auth_action_tokens SET consumed_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND consumed_at IS NULL",
      [rows[0].id],
    );
    return rows[0].user_id;
  }

  async listSessions(userId: string, tenantId: string): Promise<StoredSessionSummary[]> {
    const [rows] = await this.pool.execute<(RowDataPacket & { id: string; created_at: Date; expires_at: Date })[]>(`
      SELECT id, created_at, expires_at
        FROM forge_sessions
       WHERE user_id = ? AND tenant_id = ? AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP(3)
       ORDER BY created_at DESC
    `, [userId, tenantId]);
    return rows.map((row) => ({ id: row.id, createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString() }));
  }

  async revokeUserSession(userId: string, tenantId: string, sessionId: string) {
    const [result] = await this.pool.execute<ResultSetHeader>(
      "UPDATE forge_sessions SET revoked_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND user_id = ? AND tenant_id = ? AND revoked_at IS NULL",
      [sessionId, userId, tenantId],
    );
    return result.affectedRows > 0;
  }

  async revokeOtherSessions(userId: string, tenantId: string, currentSessionId: string) {
    const [result] = await this.pool.execute<ResultSetHeader>(
      "UPDATE forge_sessions SET revoked_at = CURRENT_TIMESTAMP(3) WHERE user_id = ? AND tenant_id = ? AND id <> ? AND revoked_at IS NULL",
      [userId, tenantId, currentSessionId],
    );
    return result.affectedRows;
  }

  private async withTenant<T>(principal: TenantPrincipal, operation: (connection: PoolConnection) => Promise<T>) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [memberships] = await connection.execute<RowDataPacket[]>(
        "SELECT 1 FROM forge_tenant_memberships WHERE tenant_id = ? AND user_id = ? AND status = 'active'",
        [principal.tenantId, principal.userId],
      );
      if (!memberships.length) throw new TenantAccessError("当前账户无权访问该租户");
      const result = await operation(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  async listResources(principal: TenantPrincipal, kind?: CloudTenantResourceKind) {
    return this.withTenant(principal, async (connection) => {
      const [rows] = kind
        ? await connection.execute<TenantResourceRow[]>(`
            SELECT ${RESOURCE_COLUMNS}
              FROM forge_tenant_resources
             WHERE tenant_id = ? AND kind = ?
             ORDER BY updated_at DESC
          `, [principal.tenantId, kind])
        : await connection.execute<TenantResourceRow[]>(`
            SELECT ${RESOURCE_COLUMNS}
              FROM forge_tenant_resources
             WHERE tenant_id = ?
             ORDER BY updated_at DESC
          `, [principal.tenantId]);
      return rows.map(mapTenantResource);
    });
  }

  async upsertResource(principal: TenantPrincipal, input: { kind: CloudTenantResourceKind; key: string; payload: Record<string, unknown>; expectedVersion?: number }) {
    return this.withTenant(principal, async (connection) => {
      let current = await this.findResourceForUpdate(connection, principal.tenantId, input.kind, input.key);
      const currentResource = current ? mapTenantResource(current) : undefined;
      if (input.expectedVersion !== undefined
        && ((!currentResource && input.expectedVersion !== 0) || (currentResource && currentResource.version !== input.expectedVersion))) {
        throw new TenantVersionConflictError(currentResource);
      }

      if (!currentResource) {
        try {
          await connection.execute(
            `INSERT INTO forge_tenant_resources
              (tenant_id, kind, resource_key, owner_user_id, updated_by_user_id, payload)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [principal.tenantId, input.kind, input.key, principal.userId, principal.userId, JSON.stringify(input.payload)],
          );
          current = await this.findResourceForUpdate(connection, principal.tenantId, input.kind, input.key);
          if (!current) throw new Error("创建租户资源后无法读取");
          return mapTenantResource(current);
        } catch (error) {
          if (!(typeof error === "object" && error && "code" in error && error.code === "ER_DUP_ENTRY")) throw error;
          current = await this.findResourceForUpdate(connection, principal.tenantId, input.kind, input.key);
          const racedResource = current ? mapTenantResource(current) : undefined;
          if (input.expectedVersion !== undefined) throw new TenantVersionConflictError(racedResource);
        }
      }

      await connection.execute(`
        UPDATE forge_tenant_resources
           SET payload = ?,
               updated_by_user_id = ?,
               version = version + 1,
               updated_at = CURRENT_TIMESTAMP(3)
         WHERE tenant_id = ? AND kind = ? AND resource_key = ?
      `, [JSON.stringify(input.payload), principal.userId, principal.tenantId, input.kind, input.key]);
      const updated = await this.findResourceForUpdate(connection, principal.tenantId, input.kind, input.key);
      if (!updated) throw new Error("更新租户资源后无法读取");
      return mapTenantResource(updated);
    });
  }

  private async findResourceForUpdate(connection: PoolConnection, tenantId: string, kind: CloudTenantResourceKind, key: string) {
    const [rows] = await connection.execute<TenantResourceRow[]>(`
      SELECT ${RESOURCE_COLUMNS}
        FROM forge_tenant_resources
       WHERE tenant_id = ? AND kind = ? AND resource_key = ?
       FOR UPDATE
    `, [tenantId, kind, key]);
    return rows[0];
  }

  async deleteResource(principal: TenantPrincipal, kind: CloudTenantResourceKind, key: string) {
    return this.withTenant(principal, async (connection) => {
      const [result] = await connection.execute<ResultSetHeader>(
        "DELETE FROM forge_tenant_resources WHERE tenant_id = ? AND kind = ? AND resource_key = ?",
        [principal.tenantId, kind, key],
      );
      return result.affectedRows > 0;
    });
  }

  async health() {
    await this.pool.query("SELECT 1");
  }

  async close() {
    await this.pool.end();
  }
}

function migrationStatements(sql: string) {
  return sql.split(";").map((statement) => statement.trim()).filter(Boolean);
}

export async function migrateDatabase(pool: Pool) {
  const migrationsPath = path.resolve(import.meta.dirname, "../migrations");
  const migrations = (await readdir(migrationsPath)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  const connection = await pool.getConnection();
  let lockAcquired = false;
  try {
    const [lockRows] = await connection.execute<LockRow[]>("SELECT GET_LOCK(?, 30) AS acquired", ["forge_cloud_migrations"]);
    lockAcquired = Number(lockRows[0]?.acquired) === 1;
    if (!lockAcquired) throw new Error("等待 Forge Cloud MySQL 迁移锁超时");
    await connection.query(`
      CREATE TABLE IF NOT EXISTS forge_schema_migrations (
        name VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
        applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB
    `);
    const [applied] = await connection.query<MigrationRow[]>("SELECT name FROM forge_schema_migrations");
    const appliedNames = new Set(applied.map((row) => row.name));
    for (const migration of migrations) {
      if (appliedNames.has(migration)) continue;
      const sql = await readFile(path.join(migrationsPath, migration), "utf8");
      for (const statement of migrationStatements(sql)) await connection.query(statement);
      await connection.execute("INSERT INTO forge_schema_migrations (name) VALUES (?)", [migration]);
    }
  } finally {
    if (lockAcquired) await connection.execute("SELECT RELEASE_LOCK(?)", ["forge_cloud_migrations"]).catch(() => undefined);
    connection.release();
  }
}
