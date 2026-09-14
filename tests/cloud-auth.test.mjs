import assert from "node:assert/strict";
import test from "node:test";
import { createCloudApi } from "../apps/cloud-api/dist/app.js";
import { DuplicateEmailError } from "../apps/cloud-api/dist/auth-service.js";
import { EncryptedBackupVersionConflictError } from "../apps/cloud-api/dist/encrypted-backups.js";
import { ResendEmailDelivery } from "../apps/cloud-api/dist/email-delivery.js";
import { hashPassword, verifyPassword } from "../apps/cloud-api/dist/password.js";
import { TenantVersionConflictError } from "../apps/cloud-api/dist/tenant-resources.js";
import { TeamAccessError, TeamConflictError, TeamNotFoundError } from "../apps/cloud-api/dist/team-service.js";

class MemoryAuthStore {
  users = new Map();
  tenants = new Map();
  memberships = new Map();
  sessions = new Map();
  actionTokens = new Map();

  async createAccount(input) {
    if ([...this.users.values()].some((user) => user.email === input.email)) throw new DuplicateEmailError("该邮箱已经注册");
    this.users.set(input.userId, {
      id: input.userId,
      email: input.email,
      displayName: input.displayName,
      passwordHash: input.passwordHash,
      emailVerifiedAt: input.emailVerifiedAt,
    });
    this.tenants.set(input.tenantId, { id: input.tenantId, name: input.tenantName, slug: input.tenantSlug, kind: "personal" });
    this.memberships.set(`${input.tenantId}:${input.userId}`, { tenantId: input.tenantId, userId: input.userId, role: "owner", status: "active" });
  }

  async findUserByEmail(email) {
    return [...this.users.values()].find((user) => user.email === email);
  }

  async findUserById(userId) {
    return this.users.get(userId);
  }

  async findDefaultTenant(userId) {
    const membership = [...this.memberships.values()].find((item) => item.userId === userId && item.status === "active");
    return membership ? { id: membership.tenantId } : undefined;
  }

  async createSession(input) {
    const user = this.users.get(input.userId);
    const tenant = this.tenants.get(input.tenantId);
    const membership = this.memberships.get(`${input.tenantId}:${input.userId}`);
    assert.ok(user && tenant && membership?.status === "active");
    const stored = {
      id: input.id,
      tokenHash: input.tokenHash,
      csrfToken: input.csrfToken,
      createdAt: new Date().toISOString(),
      expiresAt: input.expiresAt,
      user: { id: user.id, email: user.email, displayName: user.displayName, emailVerifiedAt: user.emailVerifiedAt },
      tenant,
      role: membership.role,
    };
    this.sessions.set(input.tokenHash, stored);
    return stored;
  }

  async findSession(tokenHash) {
    const session = this.sessions.get(tokenHash);
    if (!session) return undefined;
    return this.memberships.get(`${session.tenant.id}:${session.user.id}`)?.status === "active" ? session : undefined;
  }

  async revokeSession(tokenHash) {
    this.sessions.delete(tokenHash);
  }

  async createActionToken(input) {
    for (const [hash, token] of this.actionTokens) {
      if (token.userId === input.userId && token.purpose === input.purpose && !token.consumedAt) {
        this.actionTokens.set(hash, { ...token, consumedAt: new Date().toISOString() });
      }
    }
    this.actionTokens.set(input.tokenHash, { ...input, createdAt: new Date().toISOString() });
  }

  claimActionToken(hash, purpose) {
    const token = this.actionTokens.get(hash);
    if (!token || token.purpose !== purpose || token.consumedAt || Date.parse(token.expiresAt) <= Date.now()) return undefined;
    this.actionTokens.set(hash, { ...token, consumedAt: new Date().toISOString() });
    return token;
  }

  async verifyEmailWithToken(hash) {
    const token = this.claimActionToken(hash, "verify_email");
    if (!token) return undefined;
    const user = this.users.get(token.userId);
    if (!user) return undefined;
    user.emailVerifiedAt ||= new Date().toISOString();
    return user;
  }

  async resetPasswordWithToken(hash, passwordHash) {
    const token = this.claimActionToken(hash, "reset_password");
    if (!token) return false;
    const user = this.users.get(token.userId);
    if (!user) return false;
    user.passwordHash = passwordHash;
    for (const [sessionHash, session] of this.sessions) if (session.user.id === user.id) this.sessions.delete(sessionHash);
    return true;
  }

  async listSessions(userId, tenantId) {
    return [...this.sessions.values()].filter((session) => session.user.id === userId && session.tenant.id === tenantId)
      .map(({ id, createdAt, expiresAt }) => ({ id, createdAt, expiresAt }));
  }

  async revokeUserSession(userId, tenantId, sessionId) {
    const entry = [...this.sessions.entries()].find(([, session]) => session.user.id === userId && session.tenant.id === tenantId && session.id === sessionId);
    if (!entry) return false;
    this.sessions.delete(entry[0]);
    return true;
  }

  async revokeOtherSessions(userId, tenantId, currentSessionId) {
    let revoked = 0;
    for (const [hash, session] of this.sessions) {
      if (session.user.id === userId && session.tenant.id === tenantId && session.id !== currentSessionId) {
        this.sessions.delete(hash);
        revoked += 1;
      }
    }
    return revoked;
  }
}

test("Resend delivery sends account and team invitation emails with bearer auth and idempotency", async () => {
  const previousFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return new Response(null, { status: 202 });
  };
  try {
    const delivery = new ResendEmailDelivery({ apiKey: "test-resend-key", from: "Forge <no-reply@example.test>" });
    await delivery.sendEmailVerification("person@example.test", "https://forge.example.test/?verify=test-token");
    assert.equal(captured.url, "https://api.resend.com/emails");
    assert.equal(captured.init.method, "POST");
    assert.equal(captured.init.headers.authorization, "Bearer test-resend-key");
    assert.match(captured.init.headers["idempotency-key"], /^[0-9a-f-]{36}$/i);
    assert.deepEqual(JSON.parse(captured.init.body), {
      from: "Forge <no-reply@example.test>",
      to: ["person@example.test"],
      subject: "验证你的 Forge 邮箱",
      text: "请在 24 小时内打开下面的链接完成邮箱验证：\n\nhttps://forge.example.test/?verify=test-token\n\n如果不是你创建的账户，可以忽略这封邮件。",
    });
    await delivery.sendTenantInvitation(
      "member@example.test",
      "Forge 产品团队",
      "测试所有者",
      "https://forge.example.test/?invite=invite-token",
    );
    const invitation = JSON.parse(captured.init.body);
    assert.equal(invitation.to[0], "member@example.test");
    assert.equal(invitation.subject, "加入 Forge 产品团队");
    assert.match(invitation.text, /测试所有者 邀请你加入 Forge 团队“Forge 产品团队”/);
    assert.match(invitation.text, /https:\/\/forge\.example\.test\/\?invite=invite-token/);
    assert.match(invitation.text, /只有与 member@example\.test 匹配且已验证的账户可以接受/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

class MemoryEmailDelivery {
  verification = [];
  resets = [];
  invitations = [];
  async sendEmailVerification(email, url) { this.verification.push({ email, url }); }
  async sendPasswordReset(email, url) { this.resets.push({ email, url }); }
  async sendTenantInvitation(email, teamName, inviterName, url) { this.invitations.push({ email, teamName, inviterName, url }); }
}

class MemoryTeamStore {
  invitations = new Map();

  constructor(auth) { this.auth = auth; }

  async listTenants(userId) {
    return [...this.auth.memberships.values()]
      .filter((membership) => membership.userId === userId && membership.status === "active")
      .map((membership) => ({ ...this.auth.tenants.get(membership.tenantId), role: membership.role }));
  }

  async hasActiveMembership(userId, tenantId) {
    return this.auth.memberships.get(`${tenantId}:${userId}`)?.status === "active";
  }

  async createTeam(input) {
    const tenant = { id: input.tenantId, name: input.name, slug: input.slug, kind: "team" };
    this.auth.tenants.set(input.tenantId, tenant);
    this.auth.memberships.set(`${input.tenantId}:${input.userId}`, {
      tenantId: input.tenantId, userId: input.userId, role: "owner", status: "active", createdAt: new Date().toISOString(),
    });
    return { ...tenant, role: "owner" };
  }

  actor(actor, manage = false) {
    const tenant = this.auth.tenants.get(actor.tenantId);
    const membership = this.auth.memberships.get(`${actor.tenantId}:${actor.userId}`);
    if (!tenant || membership?.status !== "active") throw new TeamAccessError("当前账户无权访问该团队");
    if (tenant.kind !== "team") throw new TeamAccessError("个人工作区不支持成员管理");
    if (manage && membership.role !== "owner" && membership.role !== "admin") throw new TeamAccessError("当前角色无权管理邀请");
    return { ...tenant, role: membership.role };
  }

  async getTeamOverview(actor) {
    const tenant = this.actor(actor);
    const members = [...this.auth.memberships.values()]
      .filter((membership) => membership.tenantId === actor.tenantId && membership.status === "active")
      .map((membership) => {
        const user = this.auth.users.get(membership.userId);
        return { userId: user.id, email: user.email, displayName: user.displayName, role: membership.role, joinedAt: membership.createdAt || new Date().toISOString() };
      });
    const invitations = tenant.role === "member" ? [] : [...this.invitations.values()]
      .filter((invitation) => invitation.tenantId === actor.tenantId && !invitation.acceptedAt && !invitation.revokedAt && Date.parse(invitation.expiresAt) > Date.now())
      .map(({ tenantId: _tenantId, tokenHash: _tokenHash, ...invitation }) => invitation);
    return { tenant, members, invitations };
  }

  async createInvitation(input) {
    const tenant = this.actor({ tenantId: input.tenantId, userId: input.actorUserId }, true);
    if (tenant.role === "admin" && input.role !== "member") throw new TeamAccessError("管理员只能邀请普通成员");
    const existingUser = [...this.auth.users.values()].find((user) => user.email === input.email);
    if (existingUser && await this.hasActiveMembership(existingUser.id, input.tenantId)) throw new TeamConflictError("该邮箱已经是团队成员");
    for (const invitation of this.invitations.values()) {
      if (invitation.tenantId === input.tenantId && invitation.email === input.email && !invitation.acceptedAt) invitation.revokedAt = new Date().toISOString();
    }
    const inviter = this.auth.users.get(input.actorUserId);
    const invitation = {
      id: input.id, tenantId: input.tenantId, tokenHash: input.tokenHash, email: input.email, role: input.role,
      invitedByName: inviter.displayName, createdAt: new Date().toISOString(), expiresAt: input.expiresAt,
    };
    this.invitations.set(input.id, invitation);
    const { tenantId: _tenantId, tokenHash: _tokenHash, ...publicInvitation } = invitation;
    return { tenantName: tenant.name, invitation: publicInvitation };
  }

  async listPendingInvitations(_userId, email) {
    return [...this.invitations.values()]
      .filter((invitation) => invitation.email === email && !invitation.acceptedAt && !invitation.revokedAt && Date.parse(invitation.expiresAt) > Date.now())
      .map((invitation) => ({
        id: invitation.id, email: invitation.email, role: invitation.role, invitedByName: invitation.invitedByName,
        createdAt: invitation.createdAt, expiresAt: invitation.expiresAt,
        tenant: this.auth.tenants.get(invitation.tenantId),
      }));
  }

  async acceptInvitation(input) {
    const invitation = [...this.invitations.values()].find((item) =>
      (input.tokenHash ? item.tokenHash === input.tokenHash : item.id === input.invitationId)
      && !item.acceptedAt && !item.revokedAt && Date.parse(item.expiresAt) > Date.now());
    if (!invitation) throw new TeamNotFoundError("邀请不存在、已使用或已经过期");
    if (invitation.email !== input.email) throw new TeamAccessError("当前登录邮箱与邀请邮箱不一致");
    const key = `${invitation.tenantId}:${input.userId}`;
    if (this.auth.memberships.get(key)?.status === "active") throw new TeamConflictError("你已经是该团队成员");
    this.auth.memberships.set(key, {
      tenantId: invitation.tenantId, userId: input.userId, role: invitation.role, status: "active", createdAt: new Date().toISOString(),
    });
    invitation.acceptedAt = new Date().toISOString();
    return { ...this.auth.tenants.get(invitation.tenantId), role: invitation.role };
  }

  async revokeInvitation(actor, invitationId) {
    const tenant = this.actor(actor, true);
    const invitation = this.invitations.get(invitationId);
    if (!invitation || invitation.tenantId !== actor.tenantId || invitation.acceptedAt || invitation.revokedAt) return false;
    if (tenant.role === "admin" && invitation.role !== "member") throw new TeamAccessError("管理员不能撤销管理员邀请");
    invitation.revokedAt = new Date().toISOString();
    return true;
  }

  async updateMemberRole(actor, userId, role) {
    if (this.actor(actor).role !== "owner") throw new TeamAccessError("只有所有者可以调整成员角色");
    const membership = this.auth.memberships.get(`${actor.tenantId}:${userId}`);
    if (!membership || membership.status !== "active") return false;
    if (membership.role === "owner" && role !== "owner") this.protectLastOwner(actor.tenantId);
    membership.role = role;
    return true;
  }

  async removeMember(actor, userId) {
    if (this.actor(actor).role !== "owner") throw new TeamAccessError("只有所有者可以移除成员");
    const membership = this.auth.memberships.get(`${actor.tenantId}:${userId}`);
    if (!membership || membership.status !== "active") return false;
    if (membership.role === "owner") this.protectLastOwner(actor.tenantId);
    membership.status = "suspended";
    for (const [hash, session] of this.auth.sessions) if (session.user.id === userId && session.tenant.id === actor.tenantId) this.auth.sessions.delete(hash);
    return true;
  }

  protectLastOwner(tenantId) {
    const owners = [...this.auth.memberships.values()].filter((item) => item.tenantId === tenantId && item.status === "active" && item.role === "owner");
    if (owners.length <= 1) throw new TeamConflictError("团队必须至少保留一位所有者");
  }
}

class MemoryTenantStore {
  resources = new Map();

  async listResources(principal, kind) {
    return [...this.resources.values()].filter((resource) => resource.tenantId === principal.tenantId && (!kind || resource.kind === kind)).map(({ tenantId: _tenantId, ...resource }) => resource);
  }

  async upsertResource(principal, input) {
    const mapKey = `${principal.tenantId}:${input.kind}:${input.key}`;
    const existing = this.resources.get(mapKey);
    if (input.expectedVersion !== undefined
      && ((!existing && input.expectedVersion !== 0) || (existing && existing.version !== input.expectedVersion))) {
      const current = existing ? (({ tenantId: _tenantId, ...resource }) => resource)(existing) : undefined;
      throw new TenantVersionConflictError(current);
    }
    const timestamp = new Date().toISOString();
    const stored = {
      tenantId: principal.tenantId,
      kind: input.kind,
      key: input.key,
      ownerUserId: existing?.ownerUserId || principal.userId,
      updatedByUserId: principal.userId,
      payload: input.payload,
      version: (existing?.version || 0) + 1,
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
    };
    this.resources.set(mapKey, stored);
    const { tenantId: _tenantId, ...resource } = stored;
    return resource;
  }

  async deleteResource(principal, kind, key) {
    return this.resources.delete(`${principal.tenantId}:${kind}:${key}`);
  }
}

class MemoryBackupStore {
  backups = new Map();

  async getTaskBackup(principal) {
    return this.backups.get(`${principal.tenantId}:${principal.userId}`);
  }

  async upsertTaskBackup(principal, input) {
    const key = `${principal.tenantId}:${principal.userId}`;
    const current = this.backups.get(key);
    if (input.expectedVersion !== undefined
      && ((!current && input.expectedVersion !== 0) || (current && current.version !== input.expectedVersion))) {
      const metadata = current ? (({ envelope: _envelope, ...value }) => value)(current) : undefined;
      throw new EncryptedBackupVersionConflictError(metadata);
    }
    const stored = {
      envelope: input.envelope,
      version: (current?.version || 0) + 1,
      sizeBytes: input.sizeBytes,
      taskCount: input.envelope.taskCount,
      createdAt: input.envelope.createdAt,
      updatedAt: new Date().toISOString(),
    };
    this.backups.set(key, stored);
    return stored;
  }

  async deleteTaskBackup(principal) {
    return this.backups.delete(`${principal.tenantId}:${principal.userId}`);
  }
}

function sessionCookie(response) {
  const header = response.headers["set-cookie"];
  assert.equal(typeof header, "string");
  return header.split(";", 1)[0];
}

test("scrypt password hashes are salted and reject an incorrect password", async () => {
  const password = "这是一个足够长的测试密码 phrase";
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword("incorrect-password", first), false);
});

test("registration creates a personal tenant and stores only a session-token digest", async () => {
  const store = new MemoryAuthStore();
  const app = await createCloudApi({ store, allowedOrigins: ["http://127.0.0.1:5173"], cookieSecure: false });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      headers: { origin: "http://127.0.0.1:5173" },
      payload: { email: "  Person@Example.COM ", displayName: "测试用户", password: "a secure passphrase 2026" },
    });
    assert.equal(response.statusCode, 201);
    const payload = response.json();
    assert.equal(payload.authenticated, true);
    assert.equal(payload.user.email, "person@example.com");
    assert.equal(payload.user.emailVerified, true);
    assert.match(payload.sessionId, /^[0-9a-f-]{36}$/);
    assert.equal(payload.tenant.role, "owner");
    assert.equal(payload.tenant.name, "测试用户的工作区");
    assert.equal("token" in payload, false);

    const cookie = sessionCookie(response);
    assert.match(response.headers["set-cookie"], /HttpOnly/i);
    assert.match(response.headers["set-cookie"], /SameSite=Lax/i);
    const rawToken = cookie.slice(cookie.indexOf("=") + 1);
    assert.equal([...store.sessions.keys()].includes(rawToken), false);
    assert.match([...store.sessions.keys()][0], /^[a-f0-9]{64}$/);

    const sessionResponse = await app.inject({ method: "GET", url: "/v1/auth/session", headers: { cookie } });
    assert.equal(sessionResponse.statusCode, 200);
    assert.equal(sessionResponse.json().tenant.id, payload.tenant.id);

    const spoofedTenant = await app.inject({
      method: "GET",
      url: "/v1/account",
      headers: { cookie, "x-tenant-id": "00000000-0000-0000-0000-000000000000" },
    });
    assert.equal(spoofedTenant.statusCode, 200);
    assert.equal(spoofedTenant.json().tenant.id, payload.tenant.id);

    const missingCsrf = await app.inject({ method: "POST", url: "/v1/auth/logout", headers: { cookie, origin: "http://127.0.0.1:5173" } });
    assert.equal(missingCsrf.statusCode, 403);
    const logout = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { cookie, origin: "http://127.0.0.1:5173", "x-csrf-token": payload.csrfToken },
    });
    assert.equal(logout.statusCode, 204);
    const afterLogout = await app.inject({ method: "GET", url: "/v1/auth/session", headers: { cookie } });
    assert.deepEqual(afterLogout.json(), { authenticated: false });
  } finally {
    await app.close();
  }
});

test("email verification, password recovery, and session revocation form a complete account lifecycle", async () => {
  const store = new MemoryAuthStore();
  const tenantStore = new MemoryTenantStore();
  const delivery = new MemoryEmailDelivery();
  const origin = "https://forge.example";
  const app = await createCloudApi({
    store,
    tenantStore,
    emailDelivery: delivery,
    publicWebUrl: `${origin}/?cloud=1`,
    allowedOrigins: [origin],
    cookieSecure: true,
    requireOriginForUnsafeRequests: true,
  });
  try {
    const missingOrigin = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "secure@example.com", password: "correct horse battery staple" },
    });
    assert.equal(missingOrigin.statusCode, 403);
    assert.deepEqual(missingOrigin.json(), { message: "请求缺少可信来源" });

    const registered = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      headers: { origin },
      payload: { email: "secure@example.com", displayName: "Secure User", password: "correct horse battery staple" },
    });
    assert.equal(registered.statusCode, 201);
    assert.equal(registered.json().user.emailVerified, false);
    assert.equal(registered.json().verificationDelivery, "sent");
    assert.equal(delivery.verification.length, 1);
    const unverifiedCookie = sessionCookie(registered);
    assert.match(unverifiedCookie, /^__Host-forge_cloud_session=/);
    assert.match(registered.headers["set-cookie"], /; Secure;/i);
    assert.doesNotMatch(registered.headers["set-cookie"], /Domain=/i);
    assert.equal(registered.headers["x-frame-options"], "DENY");
    assert.equal(registered.headers["content-security-policy"], "default-src 'none'; frame-ancestors 'none'");
    const blockedResource = await app.inject({ method: "GET", url: "/v1/tenant/resources", headers: { cookie: unverifiedCookie } });
    assert.equal(blockedResource.statusCode, 403);

    const verificationToken = new URL(delivery.verification[0].url).searchParams.get("verify");
    assert.ok(verificationToken);
    assert.equal(store.actionTokens.has(verificationToken), false);
    assert.match([...store.actionTokens.keys()][0], /^[a-f0-9]{64}$/);
    const verified = await app.inject({
      method: "POST",
      url: "/v1/auth/email/verify",
      headers: { origin },
      payload: { token: verificationToken },
    });
    assert.equal(verified.statusCode, 200);
    assert.equal(verified.json().user.emailVerified, true);
    const verifiedCookie = sessionCookie(verified);
    const replayVerification = await app.inject({ method: "POST", url: "/v1/auth/email/verify", headers: { origin }, payload: { token: verificationToken } });
    assert.equal(replayVerification.statusCode, 400);

    const sessions = await app.inject({ method: "GET", url: "/v1/auth/sessions", headers: { cookie: verifiedCookie } });
    assert.equal(sessions.statusCode, 200);
    assert.equal(sessions.json().sessions.length, 2);
    assert.equal(sessions.json().sessions.filter((session) => session.current).length, 1);

    const unknownReset = await app.inject({ method: "POST", url: "/v1/auth/password/forgot", headers: { origin }, payload: { email: "missing@example.com" } });
    const knownReset = await app.inject({ method: "POST", url: "/v1/auth/password/forgot", headers: { origin }, payload: { email: "secure@example.com" } });
    assert.equal(unknownReset.statusCode, 202);
    assert.deepEqual(unknownReset.json(), knownReset.json());
    assert.equal(delivery.resets.length, 1);
    const resetToken = new URL(delivery.resets[0].url).searchParams.get("reset");
    assert.ok(resetToken);
    assert.equal(store.actionTokens.has(resetToken), false);
    const reset = await app.inject({
      method: "POST",
      url: "/v1/auth/password/reset",
      headers: { origin },
      payload: { token: resetToken, password: "a new secure passphrase 2026" },
    });
    assert.equal(reset.statusCode, 204);
    assert.deepEqual((await app.inject({ method: "GET", url: "/v1/auth/session", headers: { cookie: verifiedCookie } })).json(), { authenticated: false });
    assert.equal((await app.inject({ method: "POST", url: "/v1/auth/login", headers: { origin }, payload: { email: "secure@example.com", password: "correct horse battery staple" } })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/v1/auth/password/reset", headers: { origin }, payload: { token: resetToken, password: "another secure passphrase" } })).statusCode, 400);

    const firstLogin = await app.inject({ method: "POST", url: "/v1/auth/login", headers: { origin }, payload: { email: "secure@example.com", password: "a new secure passphrase 2026" } });
    const secondLogin = await app.inject({ method: "POST", url: "/v1/auth/login", headers: { origin }, payload: { email: "secure@example.com", password: "a new secure passphrase 2026" } });
    assert.equal(firstLogin.statusCode, 200);
    assert.equal(secondLogin.statusCode, 200);
    const secondCookie = sessionCookie(secondLogin);
    const revokeOthers = await app.inject({
      method: "POST",
      url: "/v1/auth/sessions/revoke-others",
      headers: { cookie: secondCookie, origin, "x-csrf-token": secondLogin.json().csrfToken },
    });
    assert.deepEqual(revokeOthers.json(), { revoked: 1 });
    assert.deepEqual((await app.inject({ method: "GET", url: "/v1/auth/session", headers: { cookie: sessionCookie(firstLogin) } })).json(), { authenticated: false });

    const revokeCurrent = await app.inject({
      method: "DELETE",
      url: `/v1/auth/sessions/${secondLogin.json().sessionId}`,
      headers: { cookie: secondCookie, origin, "x-csrf-token": secondLogin.json().csrfToken },
    });
    assert.equal(revokeCurrent.statusCode, 204);
    assert.deepEqual((await app.inject({ method: "GET", url: "/v1/auth/session", headers: { cookie: secondCookie } })).json(), { authenticated: false });
  } finally {
    await app.close();
  }
});

test("team workspaces enforce invitation, role, last-owner, and tenant-switch boundaries", async () => {
  const origin = "http://127.0.0.1:5173";
  const store = new MemoryAuthStore();
  const teamStore = new MemoryTeamStore(store);
  const app = await createCloudApi({ store, teamStore, allowedOrigins: [origin], cookieSecure: false });
  const register = async (email, displayName) => {
    const response = await app.inject({
      method: "POST", url: "/v1/auth/register", headers: { origin },
      payload: { email, displayName, password: "a secure team password 2026" },
    });
    assert.equal(response.statusCode, 201);
    return { cookie: sessionCookie(response), session: response.json() };
  };
  try {
    let owner = await register("owner@example.test", "团队所有者");
    let member = await register("member@example.test", "受邀成员");

    const create = await app.inject({
      method: "POST", url: "/v1/tenants",
      headers: { origin, cookie: owner.cookie, "x-csrf-token": owner.session.csrfToken },
      payload: { name: "Forge 研发团队" },
    });
    assert.equal(create.statusCode, 201);
    const team = create.json();
    assert.equal(team.kind, "team");
    assert.equal(team.role, "owner");

    const switchedOwner = await app.inject({
      method: "POST", url: "/v1/auth/tenant",
      headers: { origin, cookie: owner.cookie, "x-csrf-token": owner.session.csrfToken },
      payload: { tenantId: team.id },
    });
    assert.equal(switchedOwner.statusCode, 200);
    owner = { cookie: sessionCookie(switchedOwner), session: switchedOwner.json() };
    assert.equal(owner.session.tenant.id, team.id);

    const invite = await app.inject({
      method: "POST", url: "/v1/team/invitations",
      headers: { origin, cookie: owner.cookie, "x-csrf-token": owner.session.csrfToken },
      payload: { email: "MEMBER@example.test", role: "member" },
    });
    assert.equal(invite.statusCode, 201);
    assert.equal(invite.json().delivery, "unavailable");

    const pending = await app.inject({ method: "GET", url: "/v1/invitations", headers: { cookie: member.cookie } });
    assert.equal(pending.statusCode, 200);
    assert.equal(pending.json().invitations.length, 1);
    assert.equal(pending.json().invitations[0].tenant.id, team.id);

    const accepted = await app.inject({
      method: "POST", url: "/v1/invitations/accept",
      headers: { origin, cookie: member.cookie, "x-csrf-token": member.session.csrfToken },
      payload: { invitationId: pending.json().invitations[0].id },
    });
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.json().role, "member");

    const repeated = await app.inject({
      method: "POST", url: "/v1/invitations/accept",
      headers: { origin, cookie: member.cookie, "x-csrf-token": member.session.csrfToken },
      payload: { invitationId: pending.json().invitations[0].id },
    });
    assert.equal(repeated.statusCode, 404);

    const switchedMember = await app.inject({
      method: "POST", url: "/v1/auth/tenant",
      headers: { origin, cookie: member.cookie, "x-csrf-token": member.session.csrfToken },
      payload: { tenantId: team.id },
    });
    assert.equal(switchedMember.statusCode, 200);
    member = { cookie: sessionCookie(switchedMember), session: switchedMember.json() };

    const memberCannotInvite = await app.inject({
      method: "POST", url: "/v1/team/invitations",
      headers: { origin, cookie: member.cookie, "x-csrf-token": member.session.csrfToken },
      payload: { email: "third@example.test", role: "member" },
    });
    assert.equal(memberCannotInvite.statusCode, 403);

    const demoteLastOwner = await app.inject({
      method: "PATCH", url: `/v1/team/members/${owner.session.user.id}`,
      headers: { origin, cookie: owner.cookie, "x-csrf-token": owner.session.csrfToken },
      payload: { role: "admin" },
    });
    assert.equal(demoteLastOwner.statusCode, 409);
    assert.match(demoteLastOwner.json().message, /至少保留一位所有者/);

    const promote = await app.inject({
      method: "PATCH", url: `/v1/team/members/${member.session.user.id}`,
      headers: { origin, cookie: owner.cookie, "x-csrf-token": owner.session.csrfToken },
      payload: { role: "owner" },
    });
    assert.equal(promote.statusCode, 204);

    const tenants = await app.inject({ method: "GET", url: "/v1/tenants", headers: { cookie: member.cookie } });
    assert.equal(tenants.statusCode, 200);
    assert.equal(tenants.json().tenants.some((tenant) => tenant.id === team.id && tenant.role === "owner"), true);
  } finally {
    await app.close();
  }
});

test("encrypted task backups are opaque, optimistic, user-scoped, and deletable", async () => {
  const origin = "http://127.0.0.1:5173";
  const authStore = new MemoryAuthStore();
  const backupStore = new MemoryBackupStore();
  const app = await createCloudApi({ store: authStore, backupStore, allowedOrigins: [origin], cookieSecure: false });
  const register = async (email, displayName) => {
    const response = await app.inject({
      method: "POST", url: "/v1/auth/register", headers: { origin },
      payload: { email, displayName, password: "a secure backup password 2026" },
    });
    assert.equal(response.statusCode, 201);
    return { cookie: sessionCookie(response), session: response.json() };
  };
  const envelope = {
    format: "forge-task-backup", formatVersion: 1, encryption: "aes-256-gcm", compression: "gzip", keyDerivation: "scrypt",
    salt: Buffer.alloc(16, 1).toString("base64"), iv: Buffer.alloc(12, 2).toString("base64"),
    authTag: Buffer.alloc(16, 3).toString("base64"), ciphertext: Buffer.from("opaque encrypted task history").toString("base64"),
    createdAt: new Date().toISOString(), taskCount: 3,
  };
  try {
    const accountA = await register("backup-a@example.test", "Backup A");
    const accountB = await register("backup-b@example.test", "Backup B");
    const empty = await app.inject({ method: "GET", url: "/v1/backups/tasks", headers: { cookie: accountA.cookie } });
    assert.equal(empty.statusCode, 200);
    assert.equal(empty.json().backup, undefined);
    const upload = await app.inject({
      method: "PUT", url: "/v1/backups/tasks",
      headers: { origin, cookie: accountA.cookie, "x-csrf-token": accountA.session.csrfToken, "x-tenant-id": accountB.session.tenant.id },
      payload: { envelope, expectedVersion: 0 },
    });
    assert.equal(upload.statusCode, 200);
    assert.equal(upload.json().version, 1);
    assert.equal(upload.json().taskCount, 3);
    assert.equal("envelope" in upload.json(), false);
    const isolated = await app.inject({ method: "GET", url: "/v1/backups/tasks", headers: { cookie: accountB.cookie } });
    assert.equal(isolated.json().backup, undefined);
    const download = await app.inject({ method: "GET", url: "/v1/backups/tasks/download", headers: { cookie: accountA.cookie } });
    assert.equal(download.statusCode, 200);
    assert.deepEqual(download.json().envelope, envelope);
    const stale = await app.inject({
      method: "PUT", url: "/v1/backups/tasks",
      headers: { origin, cookie: accountA.cookie, "x-csrf-token": accountA.session.csrfToken },
      payload: { envelope, expectedVersion: 0 },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal("envelope" in stale.json().current, false);
    const noCsrf = await app.inject({ method: "DELETE", url: "/v1/backups/tasks", headers: { origin, cookie: accountA.cookie } });
    assert.equal(noCsrf.statusCode, 403);
    const removed = await app.inject({
      method: "DELETE", url: "/v1/backups/tasks",
      headers: { origin, cookie: accountA.cookie, "x-csrf-token": accountA.session.csrfToken },
    });
    assert.equal(removed.statusCode, 204);
  } finally {
    await app.close();
  }
});

test("cloud auth UI is optional and never stores a session token in web storage", async () => {
  const { readFile } = await import("node:fs/promises");
  const gate = await readFile("apps/web/src/CloudAuthGate.tsx", "utf8");
  const cloudApp = await readFile("apps/cloud-api/src/app.ts", "utf8");
  const preload = await readFile("apps/desktop/preload.cjs", "utf8");
  const migration = await readFile("apps/cloud-api/migrations/001_identity.sql", "utf8");
  const tenantMigration = await readFile("apps/cloud-api/migrations/002_tenant_resources.sql", "utf8");
  const accountSecurityMigration = await readFile("apps/cloud-api/migrations/003_account_security.sql", "utf8");
  const mysqlStore = await readFile("apps/cloud-api/src/mysql-store.ts", "utf8");
  const cloudServer = await readFile("apps/cloud-api/src/server.ts", "utf8");
  const deploymentConfig = await readFile("apps/cloud-api/src/deployment-config.ts", "utf8");
  const emailDelivery = await readFile("apps/cloud-api/src/email-delivery.ts", "utf8");
  const cloudDockerfile = await readFile("apps/cloud-api/Dockerfile", "utf8");
  const appUser = await readFile("infra/mysql/init/001_app_user.sql", "utf8");
  const syncPanel = await readFile("apps/web/src/CloudWorkspacePanel.tsx", "utf8");
  assert.match(gate, /credentials: "include"/);
  assert.doesNotMatch(gate, /localStorage|sessionStorage/);
  assert.match(cloudApp, /httpOnly: true/);
  assert.match(preload, /FORGE_CLOUD_API_URL/);
  assert.match(migration, /PRIMARY KEY \(tenant_id, user_id\)/);
  assert.match(migration, /token_hash CHAR\(64\)/);
  assert.doesNotMatch(migration, /\btoken text\b/i);
  assert.match(tenantMigration, /PRIMARY KEY \(tenant_id, kind, resource_key\)/);
  assert.match(tenantMigration, /FOREIGN KEY \(tenant_id, owner_user_id\)/);
  assert.match(accountSecurityMigration, /token_hash CHAR\(64\)/);
  assert.doesNotMatch(accountSecurityMigration, /\btoken text\b/i);
  assert.match(accountSecurityMigration, /purpose ENUM\('verify_email', 'reset_password'\)/);
  assert.match(mysqlStore, /WHERE tenant_id = \? AND user_id = \?/);
  assert.match(mysqlStore, /WHERE tenant_id = \? AND kind = \?/);
  assert.match(mysqlStore, /WHERE user_id = \? AND tenant_id = \?/);
  assert.match(mysqlStore, /GET_LOCK/);
  assert.match(mysqlStore, /forge_schema_migrations/);
  assert.match(deploymentConfig, /FORGE_CLOUD_MIGRATION_DATABASE_URL/);
  assert.match(deploymentConfig, /FORGE_CLOUD_RESEND_API_KEY/);
  assert.match(cloudServer, /req\.headers\.cookie/);
  assert.match(cloudServer, /requireOriginForUnsafeRequests: config\.production/);
  assert.match(cloudApp, /__Host-forge_cloud_session/);
  assert.match(emailDelivery, /https:\/\/api\.resend\.com\/emails/);
  assert.match(cloudDockerfile, /USER node/);
  assert.match(cloudDockerfile, /\/v1\/live/);
  assert.match(appUser, /GRANT SELECT, INSERT, UPDATE, DELETE ON forge\.\*/);
  assert.doesNotMatch(appUser, /GRANT[^;\n]*(?:CREATE|ALTER|DROP)/i);
  assert.match(gate, /\/v1\/auth\/email\/verify/);
  assert.match(gate, /检查验证状态/);
  assert.match(gate, /\/v1\/auth\/password\/forgot/);
  assert.match(gate, /\/v1\/auth\/password\/reset/);
  assert.match(syncPanel, /expectedVersion/);
  assert.match(syncPanel, /\/v1\/auth\/sessions/);
  assert.match(syncPanel, /退出其他设备/);
  assert.match(syncPanel, /title: task\.title,[\s\S]*pinned: Boolean\(task\.pinned\),[\s\S]*archived: Boolean\(task\.archived\),[\s\S]*updatedAt: task\.updatedAt/);
  assert.doesNotMatch(syncPanel, /payload:\s*task\b/);
  assert.match(syncPanel, /使用云端/);
  assert.match(syncPanel, /使用本机/);
});

test("email delivery requires an explicit public web URL", async () => {
  const emailDelivery = { sendEmailVerification: async () => undefined, sendPasswordReset: async () => undefined };
  await assert.rejects(
    createCloudApi({ store: new MemoryAuthStore(), allowedOrigins: ["http://127.0.0.1:5173"], cookieSecure: false, emailDelivery }),
    /publicWebUrl/,
  );
});

test("login errors do not reveal whether an account exists", async () => {
  const store = new MemoryAuthStore();
  const app = await createCloudApi({ store, allowedOrigins: ["http://127.0.0.1:5173"], cookieSecure: false });
  try {
    const register = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: "owner@example.com", displayName: "Owner", password: "correct horse battery staple" },
    });
    assert.equal(register.statusCode, 201);

    const wrongPassword = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "owner@example.com", password: "wrong password value" } });
    const unknownAccount = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "missing@example.com", password: "wrong password value" } });
    assert.equal(wrongPassword.statusCode, 401);
    assert.equal(unknownAccount.statusCode, 401);
    assert.deepEqual(wrongPassword.json(), unknownAccount.json());

    const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "OWNER@example.com", password: "correct horse battery staple" } });
    assert.equal(login.statusCode, 200);
    assert.equal(login.json().authenticated, true);
  } finally {
    await app.close();
  }
});

test("untrusted browser origins are rejected for unsafe requests", async () => {
  const app = await createCloudApi({ store: new MemoryAuthStore(), allowedOrigins: ["http://127.0.0.1:5173"], cookieSecure: false });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
      payload: { email: "person@example.com", displayName: "Person", password: "correct horse battery staple" },
    });
    assert.equal(response.statusCode, 403);
  } finally {
    await app.close();
  }
});

test("cross-site cookies cannot be configured without transport security", async () => {
  await assert.rejects(
    createCloudApi({
      store: new MemoryAuthStore(),
      allowedOrigins: ["https://forge.example"],
      cookieSecure: false,
      cookieSameSite: "none",
    }),
    /requires secure cookies/,
  );
});

test("tenant resource APIs derive ownership from each authenticated session", async () => {
  const authStore = new MemoryAuthStore();
  const tenantStore = new MemoryTenantStore();
  const origin = "http://127.0.0.1:5173";
  const app = await createCloudApi({ store: authStore, tenantStore, allowedOrigins: [origin], cookieSecure: false });
  try {
    const register = async (email, displayName) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/register",
        headers: { origin },
        payload: { email, displayName, password: "correct horse battery staple" },
      });
      assert.equal(response.statusCode, 201);
      return { session: response.json(), cookie: sessionCookie(response) };
    };
    const accountA = await register("tenant-a@example.com", "Tenant A");
    const accountB = await register("tenant-b@example.com", "Tenant B");

    const putA = await app.inject({
      method: "PUT",
      url: "/v1/tenant/resources/task/shared-task-key",
      headers: {
        cookie: accountA.cookie,
        origin,
        "x-csrf-token": accountA.session.csrfToken,
        "x-tenant-id": accountB.session.tenant.id,
      },
      payload: { payload: { title: "A 的任务", state: "idle" } },
    });
    assert.equal(putA.statusCode, 200);
    assert.equal(putA.json().ownerUserId, accountA.session.user.id);

    const putB = await app.inject({
      method: "PUT",
      url: "/v1/tenant/resources/task/shared-task-key",
      headers: { cookie: accountB.cookie, origin, "x-csrf-token": accountB.session.csrfToken },
      payload: { payload: { title: "B 的任务", state: "idle" } },
    });
    assert.equal(putB.statusCode, 200);

    const staleWrite = await app.inject({
      method: "PUT",
      url: "/v1/tenant/resources/task/shared-task-key",
      headers: { cookie: accountA.cookie, origin, "x-csrf-token": accountA.session.csrfToken },
      payload: { payload: { title: "不应覆盖", pinned: false, archived: false, updatedAt: new Date().toISOString() }, expectedVersion: 0 },
    });
    assert.equal(staleWrite.statusCode, 409);
    assert.equal(staleWrite.json().current.payload.title, "A 的任务");

    const expectedWrite = await app.inject({
      method: "PUT",
      url: "/v1/tenant/resources/task/shared-task-key",
      headers: { cookie: accountA.cookie, origin, "x-csrf-token": accountA.session.csrfToken },
      payload: { payload: { title: "A 的新目录", pinned: true, archived: false, updatedAt: new Date().toISOString() }, expectedVersion: 1 },
    });
    assert.equal(expectedWrite.statusCode, 200);
    assert.equal(expectedWrite.json().version, 2);

    const extensionUpdatedAt = new Date().toISOString();
    const putSkill = await app.inject({
      method: "PUT",
      url: "/v1/tenant/resources/skill/global%3Aforge-code-review",
      headers: { cookie: accountA.cookie, origin, "x-csrf-token": accountA.session.csrfToken },
      payload: {
        payload: {
          marketplaceId: "forge-code-review",
          marketplaceVersion: "1.0.0",
          scope: "global",
          enabled: true,
          updatedAt: extensionUpdatedAt,
        },
        expectedVersion: 0,
      },
    });
    assert.equal(putSkill.statusCode, 200);
    assert.equal(putSkill.json().key, "global:forge-code-review");
    assert.deepEqual(Object.keys(putSkill.json().payload).sort(), ["enabled", "marketplaceId", "marketplaceVersion", "scope", "updatedAt"]);

    const putMcp = await app.inject({
      method: "PUT",
      url: "/v1/tenant/resources/mcp/market%3Acontext7",
      headers: { cookie: accountA.cookie, origin, "x-csrf-token": accountA.session.csrfToken },
      payload: {
        payload: {
          marketplaceId: "context7",
          marketplaceVersion: "2.0.0",
          transport: "http",
          enabled: false,
          approvalMode: "writes",
          updatedAt: extensionUpdatedAt,
        },
        expectedVersion: 0,
      },
    });
    assert.equal(putMcp.statusCode, 200);

    const listSkillsB = await app.inject({ method: "GET", url: "/v1/tenant/resources?kind=skill", headers: { cookie: accountB.cookie } });
    assert.deepEqual(listSkillsB.json().resources, []);

    const listA = await app.inject({ method: "GET", url: "/v1/tenant/resources?kind=task", headers: { cookie: accountA.cookie } });
    const listB = await app.inject({ method: "GET", url: "/v1/tenant/resources?kind=task", headers: { cookie: accountB.cookie } });
    assert.equal(listA.json().tenantId, accountA.session.tenant.id);
    assert.equal(listB.json().tenantId, accountB.session.tenant.id);
    assert.equal(listA.json().resources[0].payload.title, "A 的新目录");
    assert.equal(listB.json().resources[0].payload.title, "B 的任务");

    const secret = await app.inject({
      method: "PUT",
      url: "/v1/tenant/resources/mcp/unsafe",
      headers: { cookie: accountA.cookie, origin, "x-csrf-token": accountA.session.csrfToken },
      payload: { payload: { name: "unsafe", apiKey: "must-not-sync" } },
    });
    assert.equal(secret.statusCode, 400);

    const executableMcpConfig = await app.inject({
      method: "PUT",
      url: "/v1/tenant/resources/mcp/unsafe-config",
      headers: { cookie: accountA.cookie, origin, "x-csrf-token": accountA.session.csrfToken },
      payload: { payload: { marketplaceId: "unsafe", marketplaceVersion: "1", command: "powershell", args: "secret" } },
    });
    assert.equal(executableMcpConfig.statusCode, 400);

    const credentialHint = await app.inject({
      method: "PUT",
      url: "/v1/tenant/resources/mcp/credential-hint",
      headers: { cookie: accountA.cookie, origin, "x-csrf-token": accountA.session.csrfToken },
      payload: {
        payload: {
          marketplaceId: "context7",
          marketplaceVersion: "2.0.0",
          transport: "http",
          enabled: true,
          approvalMode: "writes",
          useBearerToken: true,
          updatedAt: extensionUpdatedAt,
        },
      },
    });
    assert.equal(credentialHint.statusCode, 400);

    const incompleteSkill = await app.inject({
      method: "PUT",
      url: "/v1/tenant/resources/skill/incomplete",
      headers: { cookie: accountA.cookie, origin, "x-csrf-token": accountA.session.csrfToken },
      payload: { payload: { marketplaceId: "forge-code-review", marketplaceVersion: "1.0.0", scope: "global" } },
    });
    assert.equal(incompleteSkill.statusCode, 400);

    const noCsrf = await app.inject({ method: "DELETE", url: "/v1/tenant/resources/task/shared-task-key", headers: { cookie: accountA.cookie, origin } });
    assert.equal(noCsrf.statusCode, 403);
    const deleteA = await app.inject({
      method: "DELETE",
      url: "/v1/tenant/resources/task/shared-task-key",
      headers: { cookie: accountA.cookie, origin, "x-csrf-token": accountA.session.csrfToken },
    });
    assert.equal(deleteA.statusCode, 204);
    const afterDeleteB = await app.inject({ method: "GET", url: "/v1/tenant/resources?kind=task", headers: { cookie: accountB.cookie } });
    assert.equal(afterDeleteB.json().resources.length, 1);
  } finally {
    await app.close();
  }
});
