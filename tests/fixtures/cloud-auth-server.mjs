import assert from "node:assert/strict";
import { createCloudApi } from "../../apps/cloud-api/dist/app.js";
import { DuplicateEmailError } from "../../apps/cloud-api/dist/auth-service.js";

class QaAuthStore {
  users = new Map();
  tenants = new Map();
  memberships = new Map();
  sessions = new Map();

  async createAccount(input) {
    if ([...this.users.values()].some((user) => user.email === input.email)) throw new DuplicateEmailError("该邮箱已经注册");
    this.users.set(input.userId, { id: input.userId, email: input.email, displayName: input.displayName, passwordHash: input.passwordHash });
    this.tenants.set(input.tenantId, { id: input.tenantId, name: input.tenantName, slug: input.tenantSlug });
    this.memberships.set(input.userId, { tenantId: input.tenantId, role: "owner" });
  }

  async findUserByEmail(email) { return [...this.users.values()].find((user) => user.email === email); }
  async findDefaultTenant(userId) { return this.memberships.has(userId) ? { id: this.memberships.get(userId).tenantId } : undefined; }

  async createSession(input) {
    const user = this.users.get(input.userId);
    const tenant = this.tenants.get(input.tenantId);
    const membership = this.memberships.get(input.userId);
    assert.ok(user && tenant && membership?.tenantId === tenant.id);
    const session = {
      tokenHash: input.tokenHash,
      csrfToken: input.csrfToken,
      expiresAt: input.expiresAt,
      user: { id: user.id, email: user.email, displayName: user.displayName },
      tenant,
      role: membership.role,
    };
    this.sessions.set(input.tokenHash, session);
    return session;
  }

  async findSession(hash) { return this.sessions.get(hash); }
  async revokeSession(hash) { this.sessions.delete(hash); }
}

const app = await createCloudApi({
  store: new QaAuthStore(),
  allowedOrigins: ["http://127.0.0.1:5173", "http://localhost:5173", "http://127.0.0.1:5174"],
  cookieSecure: false,
});
await app.listen({ host: "127.0.0.1", port: Number(process.env.FORGE_CLOUD_PORT || 4790) });
console.log("Forge Cloud QA API: ready");

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
