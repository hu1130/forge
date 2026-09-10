import { readFile } from "node:fs/promises";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import { DuplicateEmailError, type AuthStore, type StoredSession, type StoredUser } from "./auth-service.js";

interface SessionRow {
  token_hash: string;
  csrf_token: string;
  expires_at: Date;
  user_id: string;
  email: string;
  display_name: string;
  disabled_at: Date | null;
  tenant_id: string;
  tenant_name: string;
  tenant_slug: string;
  role: "owner" | "admin" | "member";
}

function mapSession(row: SessionRow): StoredSession {
  return {
    tokenHash: row.token_hash,
    csrfToken: row.csrf_token,
    expiresAt: row.expires_at.toISOString(),
    user: {
      id: row.user_id,
      email: row.email,
      displayName: row.display_name,
      ...(row.disabled_at ? { disabledAt: row.disabled_at.toISOString() } : {}),
    },
    tenant: { id: row.tenant_id, name: row.tenant_name, slug: row.tenant_slug },
    role: row.role,
  };
}

const SESSION_QUERY = `
  SELECT s.token_hash, s.csrf_token, s.expires_at,
         u.id AS user_id, u.email, u.display_name, u.disabled_at,
         t.id AS tenant_id, t.name AS tenant_name, t.slug AS tenant_slug,
         m.role
    FROM forge_sessions s
    JOIN forge_users u ON u.id = s.user_id
    JOIN forge_tenants t ON t.id = s.tenant_id
    JOIN forge_tenant_memberships m ON m.tenant_id = s.tenant_id AND m.user_id = s.user_id
`;

export class PostgresAuthStore implements AuthStore {
  constructor(readonly pool: Pool) {}

  async createAccount(input: { userId: string; tenantId: string; email: string; displayName: string; passwordHash: string; tenantName: string; tenantSlug: string }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO forge_users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)",
        [input.userId, input.email, input.displayName, input.passwordHash],
      );
      await client.query(
        "INSERT INTO forge_tenants (id, name, slug, kind) VALUES ($1, $2, $3, 'personal')",
        [input.tenantId, input.tenantName, input.tenantSlug],
      );
      await client.query(
        "INSERT INTO forge_tenant_memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')",
        [input.tenantId, input.userId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (typeof error === "object" && error && "code" in error && error.code === "23505") throw new DuplicateEmailError("该邮箱已经注册");
      throw error;
    } finally {
      client.release();
    }
  }

  async findUserByEmail(email: string): Promise<StoredUser | undefined> {
    const result = await this.pool.query<{
      id: string; email: string; display_name: string; password_hash: string; disabled_at: Date | null;
    }>("SELECT id, email, display_name, password_hash, disabled_at FROM forge_users WHERE email = $1", [email]);
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      passwordHash: row.password_hash,
      ...(row.disabled_at ? { disabledAt: row.disabled_at.toISOString() } : {}),
    };
  }

  async findDefaultTenant(userId: string) {
    const result = await this.pool.query<{ id: string }>(`
      SELECT t.id
        FROM forge_tenant_memberships m
        JOIN forge_tenants t ON t.id = m.tenant_id
       WHERE m.user_id = $1 AND m.status = 'active'
       ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.created_at
       LIMIT 1
    `, [userId]);
    return result.rows[0];
  }

  async createSession(input: { id: string; userId: string; tenantId: string; tokenHash: string; csrfToken: string; expiresAt: string }) {
    await this.pool.query(
      "INSERT INTO forge_sessions (id, user_id, tenant_id, token_hash, csrf_token, expires_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [input.id, input.userId, input.tenantId, input.tokenHash, input.csrfToken, input.expiresAt],
    );
    const session = await this.sessionByHash(input.tokenHash);
    if (!session) throw new Error("创建会话后无法读取账户上下文");
    return session;
  }

  private async sessionByHash(tokenHash: string) {
    const result = await this.pool.query<SessionRow>(`${SESSION_QUERY} WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND m.status = 'active'`, [tokenHash]);
    return result.rows[0] ? mapSession(result.rows[0]) : undefined;
  }

  async findSession(tokenHash: string) {
    return this.sessionByHash(tokenHash);
  }

  async revokeSession(tokenHash: string) {
    await this.pool.query("UPDATE forge_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL", [tokenHash]);
  }

  async health() {
    await this.pool.query("SELECT 1");
  }

  async close() {
    await this.pool.end();
  }
}

export async function migrateDatabase(client: Pool | PoolClient) {
  const migrationPath = path.resolve(import.meta.dirname, "../migrations/001_identity.sql");
  await client.query(await readFile(migrationPath, "utf8"));
}
