import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { CloudAuthSession } from "@forge/contracts";
import { hashPassword, verifyPassword } from "./password.js";

export interface StoredUser {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  disabledAt?: string;
}

export interface StoredSession {
  tokenHash: string;
  csrfToken: string;
  expiresAt: string;
  user: Omit<StoredUser, "passwordHash">;
  tenant: { id: string; name: string; slug: string };
  role: "owner" | "admin" | "member";
}

export interface AuthStore {
  createAccount(input: { userId: string; tenantId: string; email: string; displayName: string; passwordHash: string; tenantName: string; tenantSlug: string }): Promise<void>;
  findUserByEmail(email: string): Promise<StoredUser | undefined>;
  findDefaultTenant(userId: string): Promise<{ id: string } | undefined>;
  createSession(input: { id: string; userId: string; tenantId: string; tokenHash: string; csrfToken: string; expiresAt: string }): Promise<StoredSession>;
  findSession(tokenHash: string): Promise<StoredSession | undefined>;
  revokeSession(tokenHash: string): Promise<void>;
  health?(): Promise<void>;
  close?(): Promise<void>;
}

export class DuplicateEmailError extends Error {}

export interface SessionResult {
  token: string;
  session: CloudAuthSession & { authenticated: true };
}

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const DUMMY_PASSWORD_HASH = "scrypt$32768$8$3$e45XZpPB6kVqAjSr7EFTiA$NhwA_DDuQNL_OzuJnBQjcQ2m7w2jzgOJLkJnDDGQzAM";

export function normalizeEmail(value: string) {
  return value.trim().toLocaleLowerCase("en-US");
}

export function validEmail(value: string) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function validPassword(value: string) {
  return value.length >= 15 && value.length <= 128;
}

export function tokenHash(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function publicSession(stored: StoredSession): CloudAuthSession & { authenticated: true } {
  return {
    authenticated: true,
    user: { id: stored.user.id, email: stored.user.email, displayName: stored.user.displayName },
    tenant: { ...stored.tenant, role: stored.role },
    csrfToken: stored.csrfToken,
    expiresAt: stored.expiresAt,
  };
}

function tenantSlug(displayName: string, tenantId: string) {
  const base = displayName.toLocaleLowerCase("en-US").normalize("NFKD")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "workspace";
  return `${base}-${tenantId.slice(0, 8)}`;
}

export class AuthService {
  constructor(private readonly store: AuthStore) {}

  private async issueSession(userId: string, tenantId: string): Promise<SessionResult> {
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(24).toString("base64url");
    const stored = await this.store.createSession({
      id: randomUUID(),
      userId,
      tenantId,
      tokenHash: tokenHash(token),
      csrfToken,
      expiresAt: new Date(Date.now() + SESSION_DURATION_MS).toISOString(),
    });
    return { token, session: publicSession(stored) };
  }

  async register(input: { email: string; displayName: string; password: string }): Promise<SessionResult> {
    const email = normalizeEmail(input.email);
    const displayName = input.displayName.trim();
    if (!validEmail(email)) throw new Error("请输入有效的邮箱地址");
    if (displayName.length < 2 || displayName.length > 60) throw new Error("显示名称需要 2–60 个字符");
    if (!validPassword(input.password)) throw new Error("密码需要 15–128 个字符");
    const userId = randomUUID();
    const tenantId = randomUUID();
    await this.store.createAccount({
      userId,
      tenantId,
      email,
      displayName,
      passwordHash: await hashPassword(input.password),
      tenantName: `${displayName}的工作区`,
      tenantSlug: tenantSlug(displayName, tenantId),
    });
    return this.issueSession(userId, tenantId);
  }

  async login(input: { email: string; password: string }): Promise<SessionResult | undefined> {
    const user = await this.store.findUserByEmail(normalizeEmail(input.email));
    const matches = await verifyPassword(input.password, user?.passwordHash || DUMMY_PASSWORD_HASH);
    if (!user || user.disabledAt || !matches) return undefined;
    const tenant = await this.store.findDefaultTenant(user.id);
    if (!tenant) throw new Error("账户还没有可用工作区");
    return this.issueSession(user.id, tenant.id);
  }

  async authenticate(token: string | undefined) {
    if (!token) return undefined;
    const stored = await this.store.findSession(tokenHash(token));
    if (!stored || stored.user.disabledAt || Date.parse(stored.expiresAt) <= Date.now()) return undefined;
    return publicSession(stored);
  }

  csrfMatches(session: CloudAuthSession & { authenticated: true }, submitted: string | undefined) {
    if (!submitted) return false;
    const expected = Buffer.from(session.csrfToken);
    const actual = Buffer.from(submitted);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  async logout(token: string | undefined) {
    if (token) await this.store.revokeSession(tokenHash(token));
  }
}
