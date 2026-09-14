import { randomBytes, randomUUID } from "node:crypto";
import type {
  CloudPendingInvitation, CloudTeamOverview, CloudTenantContext, CloudTenantInvitation,
} from "@forge/contracts";
import { normalizeEmail, tokenHash, validEmail } from "./auth-service.js";

export type TeamRole = "owner" | "admin" | "member";
export type InvitationRole = "admin" | "member";

export interface TeamActor {
  tenantId: string;
  userId: string;
}

export interface CreatedInvitation {
  invitation: CloudTenantInvitation;
  tenantName: string;
  token: string;
}

export interface TeamStore {
  listTenants(userId: string): Promise<CloudTenantContext[]>;
  hasActiveMembership(userId: string, tenantId: string): Promise<boolean>;
  createTeam(input: { tenantId: string; userId: string; name: string; slug: string }): Promise<CloudTenantContext>;
  getTeamOverview(actor: TeamActor): Promise<CloudTeamOverview>;
  createInvitation(input: {
    id: string;
    tokenHash: string;
    tenantId: string;
    actorUserId: string;
    email: string;
    role: InvitationRole;
    expiresAt: string;
  }): Promise<Omit<CreatedInvitation, "token">>;
  listPendingInvitations(userId: string, email: string): Promise<CloudPendingInvitation[]>;
  acceptInvitation(input: { invitationId?: string; tokenHash?: string; userId: string; email: string }): Promise<CloudTenantContext>;
  revokeInvitation(actor: TeamActor, invitationId: string): Promise<boolean>;
  updateMemberRole(actor: TeamActor, userId: string, role: TeamRole): Promise<boolean>;
  removeMember(actor: TeamActor, userId: string): Promise<boolean>;
}

export class TeamAccessError extends Error {}
export class TeamConflictError extends Error {}
export class TeamNotFoundError extends Error {}

const INVITATION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

function teamSlug(name: string, tenantId: string) {
  const base = name.toLocaleLowerCase("en-US").normalize("NFKD")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "team";
  return `${base}-${tenantId.slice(0, 8)}`;
}

export class TeamService {
  constructor(private readonly store: TeamStore) {}

  listTenants(userId: string) {
    return this.store.listTenants(userId);
  }

  async assertMembership(userId: string, tenantId: string) {
    if (!await this.store.hasActiveMembership(userId, tenantId)) throw new TeamAccessError("你无权进入这个工作区");
  }

  createTeam(userId: string, rawName: string) {
    const name = rawName.trim();
    if (name.length < 2 || name.length > 80) throw new Error("团队名称需要 2–80 个字符");
    const tenantId = randomUUID();
    return this.store.createTeam({ tenantId, userId, name, slug: teamSlug(name, tenantId) });
  }

  overview(actor: TeamActor) {
    return this.store.getTeamOverview(actor);
  }

  async invite(actor: TeamActor, rawEmail: string, role: string): Promise<CreatedInvitation> {
    const email = normalizeEmail(rawEmail);
    if (!validEmail(email)) throw new Error("请输入有效的邀请邮箱");
    if (role !== "admin" && role !== "member") throw new Error("邀请角色无效");
    const token = randomBytes(32).toString("base64url");
    const created = await this.store.createInvitation({
      id: randomUUID(),
      tokenHash: tokenHash(token),
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      email,
      role,
      expiresAt: new Date(Date.now() + INVITATION_DURATION_MS).toISOString(),
    });
    return { ...created, token };
  }

  listMine(userId: string, email: string) {
    return this.store.listPendingInvitations(userId, normalizeEmail(email));
  }

  accept(userId: string, email: string, input: { invitationId?: string; token?: string }) {
    const invitationId = input.invitationId?.trim();
    const token = input.token?.trim();
    if (!invitationId && !token) throw new Error("邀请标识无效");
    return this.store.acceptInvitation({
      ...(invitationId ? { invitationId } : {}),
      ...(token ? { tokenHash: tokenHash(token) } : {}),
      userId,
      email: normalizeEmail(email),
    });
  }

  revoke(actor: TeamActor, invitationId: string) {
    return this.store.revokeInvitation(actor, invitationId);
  }

  changeRole(actor: TeamActor, userId: string, role: string) {
    if (role !== "owner" && role !== "admin" && role !== "member") throw new Error("成员角色无效");
    return this.store.updateMemberRole(actor, userId, role);
  }

  remove(actor: TeamActor, userId: string) {
    return this.store.removeMember(actor, userId);
  }
}
