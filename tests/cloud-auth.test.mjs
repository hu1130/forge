import assert from "node:assert/strict";
import test from "node:test";
import { createCloudApi } from "../apps/cloud-api/dist/app.js";
import { DuplicateEmailError } from "../apps/cloud-api/dist/auth-service.js";
import { hashPassword, verifyPassword } from "../apps/cloud-api/dist/password.js";

class MemoryAuthStore {
  users = new Map();
  tenants = new Map();
  memberships = new Map();
  sessions = new Map();

  async createAccount(input) {
    if ([...this.users.values()].some((user) => user.email === input.email)) throw new DuplicateEmailError("该邮箱已经注册");
    this.users.set(input.userId, {
      id: input.userId,
      email: input.email,
      displayName: input.displayName,
      passwordHash: input.passwordHash,
    });
    this.tenants.set(input.tenantId, { id: input.tenantId, name: input.tenantName, slug: input.tenantSlug });
    this.memberships.set(`${input.tenantId}:${input.userId}`, { tenantId: input.tenantId, userId: input.userId, role: "owner" });
  }

  async findUserByEmail(email) {
    return [...this.users.values()].find((user) => user.email === email);
  }

  async findDefaultTenant(userId) {
    const membership = [...this.memberships.values()].find((item) => item.userId === userId);
    return membership ? { id: membership.tenantId } : undefined;
  }

  async createSession(input) {
    const user = this.users.get(input.userId);
    const tenant = this.tenants.get(input.tenantId);
    const membership = this.memberships.get(`${input.tenantId}:${input.userId}`);
    assert.ok(user && tenant && membership);
    const stored = {
      tokenHash: input.tokenHash,
      csrfToken: input.csrfToken,
      expiresAt: input.expiresAt,
      user: { id: user.id, email: user.email, displayName: user.displayName },
      tenant,
      role: membership.role,
    };
    this.sessions.set(input.tokenHash, stored);
    return stored;
  }

  async findSession(tokenHash) {
    return this.sessions.get(tokenHash);
  }

  async revokeSession(tokenHash) {
    this.sessions.delete(tokenHash);
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

test("cloud auth UI is optional and never stores a session token in web storage", async () => {
  const { readFile } = await import("node:fs/promises");
  const gate = await readFile("apps/web/src/CloudAuthGate.tsx", "utf8");
  const cloudApp = await readFile("apps/cloud-api/src/app.ts", "utf8");
  const preload = await readFile("apps/desktop/preload.cjs", "utf8");
  const migration = await readFile("apps/cloud-api/migrations/001_identity.sql", "utf8");
  assert.match(gate, /credentials: "include"/);
  assert.doesNotMatch(gate, /localStorage|sessionStorage/);
  assert.match(cloudApp, /httpOnly: true/);
  assert.match(preload, /FORGE_CLOUD_API_URL/);
  assert.match(migration, /PRIMARY KEY \(tenant_id, user_id\)/);
  assert.match(migration, /token_hash char\(64\)/);
  assert.doesNotMatch(migration, /\btoken text\b/i);
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
