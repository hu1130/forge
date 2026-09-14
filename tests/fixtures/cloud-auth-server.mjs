import assert from "node:assert/strict";
import { createCloudApi } from "../../apps/cloud-api/dist/app.js";
import { DuplicateEmailError } from "../../apps/cloud-api/dist/auth-service.js";
import { TenantVersionConflictError } from "../../apps/cloud-api/dist/tenant-resources.js";

class QaAuthStore {
  users = new Map();
  tenants = new Map();
  memberships = new Map();
  sessions = new Map();
  actionTokens = new Map();
  invitations = new Map();

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
    this.memberships.set(input.userId, { tenantId: input.tenantId, role: "owner", status: "active" });
  }

  async findUserByEmail(email) { return [...this.users.values()].find((user) => user.email === email); }
  async findUserById(userId) { return this.users.get(userId); }
  async findDefaultTenant(userId) {
    const membership = this.memberships.get(userId);
    return membership?.status === "active" ? { id: membership.tenantId } : undefined;
  }

  async createSession(input) {
    const user = this.users.get(input.userId);
    const tenant = this.tenants.get(input.tenantId);
    const membership = this.memberships.get(input.userId);
    assert.ok(user && tenant && membership?.tenantId === tenant.id && membership.status === "active");
    const session = {
      id: input.id,
      tokenHash: input.tokenHash,
      csrfToken: input.csrfToken,
      createdAt: new Date().toISOString(),
      expiresAt: input.expiresAt,
      user: { id: user.id, email: user.email, displayName: user.displayName, emailVerifiedAt: user.emailVerifiedAt },
      tenant,
      role: membership.role,
    };
    this.sessions.set(input.tokenHash, session);
    return session;
  }

  async findSession(hash) {
    const session = this.sessions.get(hash);
    return session && this.memberships.get(session.user.id)?.status === "active" ? session : undefined;
  }
  async revokeSession(hash) { this.sessions.delete(hash); }
  async createActionToken(input) { this.actionTokens.set(input.tokenHash, input); }
  async verifyEmailWithToken() { return undefined; }
  async resetPasswordWithToken() { return false; }
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

  async listTenants(userId) {
    const membership = this.memberships.get(userId);
    const tenant = membership?.status === "active" ? this.tenants.get(membership.tenantId) : undefined;
    return tenant ? [{ ...tenant, role: membership.role }] : [];
  }
  async hasActiveMembership(userId, tenantId) {
    const membership = this.memberships.get(userId);
    return membership?.tenantId === tenantId && membership.status === "active";
  }
  async createTeam(input) {
    const tenant = { id: input.tenantId, name: input.name, slug: input.slug, kind: "team" };
    this.tenants.set(input.tenantId, tenant);
    this.memberships.set(input.userId, { tenantId: input.tenantId, role: "owner", status: "active" });
    return { ...tenant, role: "owner" };
  }
  async getTeamOverview(actor) {
    const tenant = this.tenants.get(actor.tenantId);
    const membership = this.memberships.get(actor.userId);
    if (!tenant || tenant.kind !== "team" || membership?.tenantId !== tenant.id || membership.status !== "active") throw new Error("当前账户无权访问该团队");
    const members = [...this.memberships.entries()].filter(([, item]) => item.tenantId === tenant.id && item.status === "active").map(([userId, item]) => {
      const user = this.users.get(userId);
      return { userId, email: user.email, displayName: user.displayName, role: item.role, joinedAt: new Date().toISOString() };
    });
    return { tenant: { ...tenant, role: membership.role }, members, invitations: [] };
  }
  async listPendingInvitations() { return []; }
  async createInvitation() { throw new Error("QA fixture does not deliver invitations"); }
  async acceptInvitation() { throw new Error("QA fixture has no pending invitation"); }
  async revokeInvitation() { return false; }
  async updateMemberRole() { return false; }
  async removeMember() { return false; }
}

class QaTenantStore {
  resources = new Map();

  async listResources(principal, kind) {
    return [...this.resources.values()]
      .filter((resource) => resource.tenantId === principal.tenantId && (!kind || resource.kind === kind))
      .map(({ tenantId: _tenantId, ...resource }) => resource);
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

const store = new QaAuthStore();
const tenantStore = new QaTenantStore();
const app = await createCloudApi({
  store,
  tenantStore,
  teamStore: store,
  allowedOrigins: ["http://127.0.0.1:5173", "http://localhost:5173", "http://127.0.0.1:5174", "http://127.0.0.1:5175", "http://127.0.0.1:5176"],
  cookieSecure: false,
});
const qaEmail = "forge-qa@example.test";
const qaPassword = "forge qa password 2026";
async function ensureQaAccount() {
  if (!await store.findUserByEmail(qaEmail)) {
    const registered = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: qaEmail, displayName: "Forge QA", password: qaPassword },
    });
    assert.equal(registered.statusCode, 201);
  }
  const user = await store.findUserByEmail(qaEmail);
  const membership = store.memberships.get(user.id);
  return { userId: user.id, tenantId: membership.tenantId };
}
app.get("/__qa/seed", async () => ensureQaAccount());
app.get("/__qa/bootstrap", async (_request, reply) => {
  await ensureQaAccount();
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: qaEmail, password: qaPassword } });
  assert.equal(login.statusCode, 200);
  reply.header("set-cookie", login.headers["set-cookie"]);
  return reply.redirect(process.env.FORGE_QA_WEB_URL || "http://127.0.0.1:5175/?cloud=1");
});
app.post("/__qa/mutate-task/:key", async (request, reply) => {
  const identity = await ensureQaAccount();
  const current = (await tenantStore.listResources(identity, "task")).find((resource) => resource.key === request.params.key);
  if (!current) return reply.code(404).send({ message: "QA task resource not found" });
  const title = typeof request.body?.title === "string" ? request.body.title : "云端独立修改";
  return tenantStore.upsertResource(identity, {
    kind: "task",
    key: current.key,
    expectedVersion: current.version,
    payload: { ...current.payload, title, updatedAt: new Date(Date.now() + 1_000).toISOString() },
  });
});
app.post("/__qa/mutate-extension/:kind/:key", async (request, reply) => {
  const kind = request.params.kind;
  if (kind !== "skill" && kind !== "mcp") return reply.code(400).send({ message: "QA extension kind invalid" });
  const identity = await ensureQaAccount();
  const current = (await tenantStore.listResources(identity, kind)).find((resource) => resource.key === request.params.key);
  if (!current) return reply.code(404).send({ message: "QA extension resource not found" });
  const enabled = typeof request.body?.enabled === "boolean" ? request.body.enabled : !current.payload.enabled;
  return tenantStore.upsertResource(identity, {
    kind,
    key: current.key,
    expectedVersion: current.version,
    payload: { ...current.payload, enabled, updatedAt: new Date(Date.now() + 1_000).toISOString() },
  });
});
app.get("/__qa/latest-identity", async (_request, reply) => {
  const user = [...store.users.values()].at(-1);
  const membership = user ? store.memberships.get(user.id) : undefined;
  return user && membership ? { userId: user.id, tenantId: membership.tenantId } : reply.code(404).send({ message: "No QA identity" });
});
await app.listen({ host: "127.0.0.1", port: Number(process.env.FORGE_CLOUD_PORT || 4790) });
console.log("Forge Cloud QA API: ready");

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
