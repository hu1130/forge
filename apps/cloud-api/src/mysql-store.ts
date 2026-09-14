import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createPool, type Pool, type PoolConnection, type ResultSetHeader, type RowDataPacket } from "mysql2/promise";
import type {
  CloudPendingInvitation, CloudTeamOverview, CloudTenantContext, CloudTenantInvitation,
  CloudTenantMember, CloudTenantResource, CloudTenantResourceKind, EncryptedTaskBackupEnvelope,
} from "@forge/contracts";
import {
  DuplicateEmailError, type AuthActionPurpose, type AuthStore, type StoredSession,
  type StoredSessionSummary, type StoredUser,
} from "./auth-service.js";
import { TenantAccessError, TenantVersionConflictError, type TenantPrincipal, type TenantResourceStore } from "./tenant-resources.js";
import {
  TeamAccessError, TeamConflictError, TeamNotFoundError, type InvitationRole, type TeamActor,
  type TeamRole, type TeamStore,
} from "./team-service.js";
import {
  backupMetadata, EncryptedBackupVersionConflictError, type EncryptedBackupStore, type StoredEncryptedTaskBackup,
} from "./encrypted-backups.js";

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
  tenant_kind: "personal" | "team";
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

interface EncryptedBackupRow extends RowDataPacket {
  encrypted_payload: string;
  size_bytes: number;
  task_count: number;
  version: string | number;
  backup_created_at: Date;
  updated_at: Date;
}

interface IdRow extends RowDataPacket { id: string }
interface UserIdRow extends RowDataPacket { id: string; user_id: string }
interface MigrationRow extends RowDataPacket { name: string }
interface LockRow extends RowDataPacket { acquired: number | string | null }
interface TenantRow extends RowDataPacket {
  id: string;
  name: string;
  slug: string;
  kind: "personal" | "team";
  role: TeamRole;
}
interface MemberRow extends RowDataPacket {
  user_id: string;
  email: string;
  display_name: string;
  role: TeamRole;
  created_at: Date;
}
interface InvitationRow extends RowDataPacket {
  id: string;
  tenant_id: string;
  tenant_name: string;
  tenant_slug: string;
  tenant_kind: "personal" | "team";
  email: string;
  role: InvitationRole;
  invited_by_name: string;
  created_at: Date;
  expires_at: Date;
}

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

function mapEncryptedBackup(row: EncryptedBackupRow): StoredEncryptedTaskBackup {
  return {
    envelope: JSON.parse(row.encrypted_payload) as EncryptedTaskBackupEnvelope,
    version: Number(row.version),
    sizeBytes: Number(row.size_bytes),
    taskCount: Number(row.task_count),
    createdAt: row.backup_created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapInvitation(row: InvitationRow): CloudTenantInvitation {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    invitedByName: row.invited_by_name,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
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
    tenant: { id: row.tenant_id, name: row.tenant_name, slug: row.tenant_slug, kind: row.tenant_kind },
    role: row.role,
  };
}

const SESSION_QUERY = `
  SELECT s.id AS session_id, s.token_hash, s.csrf_token, s.created_at AS session_created_at, s.expires_at,
         u.id AS user_id, u.email, u.display_name, u.email_verified_at, u.disabled_at,
         t.id AS tenant_id, t.name AS tenant_name, t.slug AS tenant_slug, t.kind AS tenant_kind,
         m.role
    FROM forge_sessions s
    JOIN forge_users u ON u.id = s.user_id
    JOIN forge_tenants t ON t.id = s.tenant_id
    JOIN forge_tenant_memberships m ON m.tenant_id = s.tenant_id AND m.user_id = s.user_id
`;

const RESOURCE_COLUMNS = "kind, resource_key, owner_user_id, updated_by_user_id, payload, version, created_at, updated_at";
const ENCRYPTED_BACKUP_COLUMNS = "encrypted_payload, size_bytes, task_count, version, backup_created_at, updated_at";

export function createForgeMySqlPool(uri: string, connectionLimit: number) {
  const pool = createPool({ uri, connectionLimit, timezone: "Z" });
  pool.pool.on("connection", (connection) => {
    connection.query("SET time_zone = '+00:00'", (error) => {
      if (error) connection.destroy();
    });
  });
  return pool;
}

export class MySqlAuthStore implements AuthStore, TenantResourceStore, TeamStore, EncryptedBackupStore {
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

  async listTenants(userId: string): Promise<CloudTenantContext[]> {
    const [rows] = await this.pool.execute<TenantRow[]>(`
      SELECT t.id, t.name, t.slug, t.kind, m.role
        FROM forge_tenant_memberships m
        JOIN forge_tenants t ON t.id = m.tenant_id
       WHERE m.user_id = ? AND m.status = 'active'
       ORDER BY CASE t.kind WHEN 'personal' THEN 0 ELSE 1 END, t.name, t.id
    `, [userId]);
    return rows.map((row) => ({ id: row.id, name: row.name, slug: row.slug, kind: row.kind, role: row.role }));
  }

  async hasActiveMembership(userId: string, tenantId: string) {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      "SELECT 1 FROM forge_tenant_memberships WHERE tenant_id = ? AND user_id = ? AND status = 'active'",
      [tenantId, userId],
    );
    return rows.length > 0;
  }

  async createTeam(input: { tenantId: string; userId: string; name: string; slug: string }): Promise<CloudTenantContext> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute("INSERT INTO forge_tenants (id, name, slug, kind) VALUES (?, ?, ?, 'team')", [input.tenantId, input.name, input.slug]);
      await connection.execute(
        "INSERT INTO forge_tenant_memberships (tenant_id, user_id, role) VALUES (?, ?, 'owner')",
        [input.tenantId, input.userId],
      );
      await connection.commit();
      return { id: input.tenantId, name: input.name, slug: input.slug, kind: "team", role: "owner" };
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  async getTeamOverview(actor: TeamActor): Promise<CloudTeamOverview> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const tenant = await this.teamActor(connection, actor);
      const [memberRows] = await connection.execute<MemberRow[]>(`
        SELECT u.id AS user_id, u.email, u.display_name, m.role, m.created_at
          FROM forge_tenant_memberships m
          JOIN forge_users u ON u.id = m.user_id
         WHERE m.tenant_id = ? AND m.status = 'active'
         ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.display_name, u.id
      `, [actor.tenantId]);
      let invitations: CloudTenantInvitation[] = [];
      if (tenant.role === "owner" || tenant.role === "admin") {
        const [invitationRows] = await connection.execute<InvitationRow[]>(`
          SELECT i.id, i.tenant_id, t.name AS tenant_name, t.slug AS tenant_slug, t.kind AS tenant_kind,
                 i.email, i.role, u.display_name AS invited_by_name, i.created_at, i.expires_at
            FROM forge_tenant_invitations i
            JOIN forge_tenants t ON t.id = i.tenant_id
            JOIN forge_users u ON u.id = i.invited_by_user_id
           WHERE i.tenant_id = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > CURRENT_TIMESTAMP(3)
           ORDER BY i.created_at DESC
        `, [actor.tenantId]);
        invitations = invitationRows.map(mapInvitation);
      }
      await connection.commit();
      const members: CloudTenantMember[] = memberRows.map((row) => ({
        userId: row.user_id,
        email: row.email,
        displayName: row.display_name,
        role: row.role,
        joinedAt: row.created_at.toISOString(),
      }));
      return { tenant, members, invitations };
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  async createInvitation(input: {
    id: string; tokenHash: string; tenantId: string; actorUserId: string; email: string;
    role: InvitationRole; expiresAt: string;
  }) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const tenant = await this.teamActor(connection, { tenantId: input.tenantId, userId: input.actorUserId }, true);
      if (tenant.role === "admin" && input.role !== "member") throw new TeamAccessError("管理员只能邀请普通成员");
      const [existingMembers] = await connection.execute<RowDataPacket[]>(`
        SELECT 1
          FROM forge_users u
          JOIN forge_tenant_memberships m ON m.user_id = u.id AND m.tenant_id = ? AND m.status = 'active'
         WHERE u.email = ?
      `, [input.tenantId, input.email]);
      if (existingMembers.length) throw new TeamConflictError("该邮箱已经是团队成员");
      await connection.execute(`
        UPDATE forge_tenant_invitations
           SET revoked_at = CURRENT_TIMESTAMP(3)
         WHERE tenant_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL
      `, [input.tenantId, input.email]);
      await connection.execute(`
        INSERT INTO forge_tenant_invitations
          (id, tenant_id, email, role, token_hash, invited_by_user_id, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [input.id, input.tenantId, input.email, input.role, input.tokenHash, input.actorUserId, new Date(input.expiresAt)]);
      const [inviterRows] = await connection.execute<(RowDataPacket & { display_name: string })[]>(
        "SELECT display_name FROM forge_users WHERE id = ?",
        [input.actorUserId],
      );
      await connection.commit();
      return {
        tenantName: tenant.name,
        invitation: {
          id: input.id,
          email: input.email,
          role: input.role,
          invitedByName: inviterRows[0]?.display_name || "团队管理员",
          createdAt: new Date().toISOString(),
          expiresAt: input.expiresAt,
        },
      };
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  async listPendingInvitations(_userId: string, email: string): Promise<CloudPendingInvitation[]> {
    const [rows] = await this.pool.execute<InvitationRow[]>(`
      SELECT i.id, i.tenant_id, t.name AS tenant_name, t.slug AS tenant_slug, t.kind AS tenant_kind,
             i.email, i.role, u.display_name AS invited_by_name, i.created_at, i.expires_at
        FROM forge_tenant_invitations i
        JOIN forge_tenants t ON t.id = i.tenant_id
        JOIN forge_users u ON u.id = i.invited_by_user_id
       WHERE i.email = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > CURRENT_TIMESTAMP(3)
       ORDER BY i.created_at DESC
    `, [email]);
    return rows.map((row) => ({
      ...mapInvitation(row),
      tenant: { id: row.tenant_id, name: row.tenant_name, slug: row.tenant_slug, kind: row.tenant_kind },
    }));
  }

  async acceptInvitation(input: { invitationId?: string; tokenHash?: string; userId: string; email: string }): Promise<CloudTenantContext> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const lookup = input.tokenHash ? "i.token_hash = ?" : "i.id = ?";
      const lookupValue = input.tokenHash || input.invitationId;
      if (!lookupValue) throw new TeamNotFoundError("邀请标识无效");
      const [rows] = await connection.execute<InvitationRow[]>(`
        SELECT i.id, i.tenant_id, t.name AS tenant_name, t.slug AS tenant_slug, t.kind AS tenant_kind,
               i.email, i.role, u.display_name AS invited_by_name, i.created_at, i.expires_at
          FROM forge_tenant_invitations i
          JOIN forge_tenants t ON t.id = i.tenant_id
          JOIN forge_users u ON u.id = i.invited_by_user_id
         WHERE ${lookup} AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > CURRENT_TIMESTAMP(3)
         FOR UPDATE
      `, [lookupValue]);
      const invitation = rows[0];
      if (!invitation) throw new TeamNotFoundError("邀请不存在、已使用或已经过期");
      if (invitation.email !== input.email) throw new TeamAccessError("当前登录邮箱与邀请邮箱不一致");
      const [memberships] = await connection.execute<(RowDataPacket & { status: "active" | "suspended" })[]>(
        "SELECT status FROM forge_tenant_memberships WHERE tenant_id = ? AND user_id = ? FOR UPDATE",
        [invitation.tenant_id, input.userId],
      );
      if (memberships[0]?.status === "active") throw new TeamConflictError("你已经是该团队成员");
      if (memberships[0]) {
        await connection.execute(
          "UPDATE forge_tenant_memberships SET role = ?, status = 'active', created_at = CURRENT_TIMESTAMP(3) WHERE tenant_id = ? AND user_id = ?",
          [invitation.role, invitation.tenant_id, input.userId],
        );
      } else {
        await connection.execute(
          "INSERT INTO forge_tenant_memberships (tenant_id, user_id, role) VALUES (?, ?, ?)",
          [invitation.tenant_id, input.userId, invitation.role],
        );
      }
      await connection.execute("UPDATE forge_tenant_invitations SET accepted_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [invitation.id]);
      await connection.commit();
      return {
        id: invitation.tenant_id,
        name: invitation.tenant_name,
        slug: invitation.tenant_slug,
        kind: invitation.tenant_kind,
        role: invitation.role,
      };
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  async revokeInvitation(actor: TeamActor, invitationId: string) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const tenant = await this.teamActor(connection, actor, true);
      const [rows] = await connection.execute<(RowDataPacket & { role: InvitationRole })[]>(`
        SELECT role FROM forge_tenant_invitations
         WHERE id = ? AND tenant_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP(3)
         FOR UPDATE
      `, [invitationId, actor.tenantId]);
      if (!rows[0]) { await connection.commit(); return false; }
      if (tenant.role === "admin" && rows[0].role !== "member") throw new TeamAccessError("管理员不能撤销管理员邀请");
      await connection.execute("UPDATE forge_tenant_invitations SET revoked_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [invitationId]);
      await connection.commit();
      return true;
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  async updateMemberRole(actor: TeamActor, userId: string, role: TeamRole) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const actorTenant = await this.teamActor(connection, actor);
      if (actorTenant.role !== "owner") throw new TeamAccessError("只有所有者可以调整成员角色");
      const [targets] = await connection.execute<(RowDataPacket & { role: TeamRole })[]>(
        "SELECT role FROM forge_tenant_memberships WHERE tenant_id = ? AND user_id = ? AND status = 'active' FOR UPDATE",
        [actor.tenantId, userId],
      );
      if (!targets[0]) { await connection.commit(); return false; }
      await this.protectLastOwner(connection, actor.tenantId, targets[0].role, role !== "owner");
      await connection.execute(
        "UPDATE forge_tenant_memberships SET role = ? WHERE tenant_id = ? AND user_id = ? AND status = 'active'",
        [role, actor.tenantId, userId],
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

  async removeMember(actor: TeamActor, userId: string) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const actorTenant = await this.teamActor(connection, actor);
      if (actorTenant.role !== "owner") throw new TeamAccessError("只有所有者可以移除成员");
      const [targets] = await connection.execute<(RowDataPacket & { role: TeamRole })[]>(
        "SELECT role FROM forge_tenant_memberships WHERE tenant_id = ? AND user_id = ? AND status = 'active' FOR UPDATE",
        [actor.tenantId, userId],
      );
      if (!targets[0]) { await connection.commit(); return false; }
      await this.protectLastOwner(connection, actor.tenantId, targets[0].role, true);
      await connection.execute(
        "UPDATE forge_tenant_memberships SET status = 'suspended' WHERE tenant_id = ? AND user_id = ?",
        [actor.tenantId, userId],
      );
      await connection.execute(
        "UPDATE forge_sessions SET revoked_at = CURRENT_TIMESTAMP(3) WHERE tenant_id = ? AND user_id = ? AND revoked_at IS NULL",
        [actor.tenantId, userId],
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

  private async teamActor(connection: PoolConnection, actor: TeamActor, manage = false): Promise<CloudTenantContext> {
    const [rows] = await connection.execute<TenantRow[]>(`
      SELECT t.id, t.name, t.slug, t.kind, m.role
        FROM forge_tenants t
        JOIN forge_tenant_memberships m ON m.tenant_id = t.id
       WHERE t.id = ? AND m.user_id = ? AND m.status = 'active'
       FOR UPDATE
    `, [actor.tenantId, actor.userId]);
    const tenant = rows[0];
    if (!tenant) throw new TeamAccessError("当前账户无权访问该团队");
    if (tenant.kind !== "team") throw new TeamAccessError("个人工作区不支持成员管理");
    if (manage && tenant.role !== "owner" && tenant.role !== "admin") throw new TeamAccessError("当前角色无权管理邀请");
    return { id: tenant.id, name: tenant.name, slug: tenant.slug, kind: tenant.kind, role: tenant.role };
  }

  private async protectLastOwner(connection: PoolConnection, tenantId: string, currentRole: TeamRole, removesOwnership: boolean) {
    if (currentRole !== "owner" || !removesOwnership) return;
    const [rows] = await connection.execute<(RowDataPacket & { user_id: string })[]>(`
      SELECT user_id FROM forge_tenant_memberships
       WHERE tenant_id = ? AND role = 'owner' AND status = 'active'
       FOR UPDATE
    `, [tenantId]);
    if (rows.length <= 1) throw new TeamConflictError("团队必须至少保留一位所有者");
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

  async getTaskBackup(principal: TenantPrincipal) {
    return this.withTenant(principal, async (connection) => {
      const [rows] = await connection.execute<EncryptedBackupRow[]>(`
        SELECT ${ENCRYPTED_BACKUP_COLUMNS}
          FROM forge_encrypted_task_backups
         WHERE tenant_id = ? AND user_id = ?
      `, [principal.tenantId, principal.userId]);
      return rows[0] ? mapEncryptedBackup(rows[0]) : undefined;
    });
  }

  async upsertTaskBackup(principal: TenantPrincipal, input: {
    envelope: EncryptedTaskBackupEnvelope;
    sizeBytes: number;
    expectedVersion?: number;
  }) {
    return this.withTenant(principal, async (connection) => {
      let current = await this.findTaskBackupForUpdate(connection, principal);
      let currentBackup = current ? mapEncryptedBackup(current) : undefined;
      const currentMetadata = currentBackup ? backupMetadata(currentBackup) : undefined;
      if (input.expectedVersion !== undefined
        && ((!currentBackup && input.expectedVersion !== 0) || (currentBackup && currentBackup.version !== input.expectedVersion))) {
        throw new EncryptedBackupVersionConflictError(currentMetadata);
      }
      const encryptedPayload = JSON.stringify(input.envelope);
      if (!currentBackup) {
        try {
          await connection.execute(`
            INSERT INTO forge_encrypted_task_backups
              (tenant_id, user_id, encrypted_payload, size_bytes, task_count, backup_created_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `, [
            principal.tenantId, principal.userId, encryptedPayload, input.sizeBytes,
            input.envelope.taskCount, new Date(input.envelope.createdAt),
          ]);
          current = await this.findTaskBackupForUpdate(connection, principal);
          if (!current) throw new Error("创建加密任务备份后无法读取");
          return mapEncryptedBackup(current);
        } catch (error) {
          if (!(typeof error === "object" && error && "code" in error && error.code === "ER_DUP_ENTRY")) throw error;
          current = await this.findTaskBackupForUpdate(connection, principal);
          currentBackup = current ? mapEncryptedBackup(current) : undefined;
          throw new EncryptedBackupVersionConflictError(currentBackup ? backupMetadata(currentBackup) : undefined);
        }
      }
      await connection.execute(`
        UPDATE forge_encrypted_task_backups
           SET encrypted_payload = ?, size_bytes = ?, task_count = ?, backup_created_at = ?,
               version = version + 1, updated_at = CURRENT_TIMESTAMP(3)
         WHERE tenant_id = ? AND user_id = ?
      `, [
        encryptedPayload, input.sizeBytes, input.envelope.taskCount, new Date(input.envelope.createdAt),
        principal.tenantId, principal.userId,
      ]);
      const updated = await this.findTaskBackupForUpdate(connection, principal);
      if (!updated) throw new Error("更新加密任务备份后无法读取");
      return mapEncryptedBackup(updated);
    });
  }

  private async findTaskBackupForUpdate(connection: PoolConnection, principal: TenantPrincipal) {
    const [rows] = await connection.execute<EncryptedBackupRow[]>(`
      SELECT ${ENCRYPTED_BACKUP_COLUMNS}
        FROM forge_encrypted_task_backups
       WHERE tenant_id = ? AND user_id = ?
       FOR UPDATE
    `, [principal.tenantId, principal.userId]);
    return rows[0];
  }

  async deleteTaskBackup(principal: TenantPrincipal) {
    return this.withTenant(principal, async (connection) => {
      const [result] = await connection.execute<ResultSetHeader>(
        "DELETE FROM forge_encrypted_task_backups WHERE tenant_id = ? AND user_id = ?",
        [principal.tenantId, principal.userId],
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
