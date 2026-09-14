import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyReply, type FastifyServerOptions } from "fastify";
import type {
  CloudAuthSession, CloudPendingInvitationsPayload, CloudSessionListPayload, CloudTenantListPayload,
} from "@forge/contracts";
import { AuthService, DuplicateEmailError, type AuthStore } from "./auth-service.js";
import type { EmailDelivery } from "./email-delivery.js";
import { TenantAccessError, TenantVersionConflictError, tenantResourceKey, tenantResourceKind, tenantResourcePayload, type TenantResourceStore } from "./tenant-resources.js";
import {
  TeamAccessError, TeamConflictError, TeamNotFoundError, TeamService, type TeamStore,
} from "./team-service.js";

export interface CloudApiOptions {
  store: AuthStore;
  tenantStore?: TenantResourceStore;
  teamStore?: TeamStore;
  allowedOrigins: string[];
  cookieSecure: boolean;
  cookieSameSite?: "lax" | "none";
  emailDelivery?: EmailDelivery;
  publicWebUrl?: string;
  trustProxy?: boolean;
  requireOriginForUnsafeRequests?: boolean;
  logger?: FastifyServerOptions["logger"];
}

const COOKIE_NAME = "forge_cloud_session";
const SECURE_COOKIE_NAME = "__Host-forge_cloud_session";
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function bodyRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function createCloudApi(options: CloudApiOptions) {
  if (options.cookieSameSite === "none" && !options.cookieSecure) {
    throw new Error("SameSite=None requires secure cookies");
  }
  let publicWebUrl: URL | undefined;
  if (options.emailDelivery) {
    try {
      publicWebUrl = new URL(options.publicWebUrl || "");
      if (publicWebUrl.protocol !== "http:" && publicWebUrl.protocol !== "https:") throw new Error();
    } catch {
      throw new Error("启用邮件验证时需要有效的 publicWebUrl");
    }
  }
  const app = Fastify({ logger: options.logger || false, bodyLimit: 32 * 1024, trustProxy: options.trustProxy || false });
  const auth = new AuthService(options.store, Boolean(options.emailDelivery));
  const sessionCookieName = options.cookieSecure ? SECURE_COOKIE_NAME : COOKIE_NAME;
  await app.register(cookie);
  await app.register(cors, { origin: options.allowedOrigins, credentials: true });
  await app.register(rateLimit, { global: false });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    reply.header("referrer-policy", "no-referrer");
    reply.header("cache-control", "no-store");
    if (options.cookieSecure) reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    if (!unsafeMethods.has(request.method)) return;
    const fetchSite = request.headers["sec-fetch-site"];
    if (fetchSite === "cross-site") return reply.code(403).send({ message: "跨站请求已拒绝" });
    const origin = request.headers.origin;
    if (options.requireOriginForUnsafeRequests && !origin) return reply.code(403).send({ message: "请求缺少可信来源" });
    if (origin && !options.allowedOrigins.includes(origin)) return reply.code(403).send({ message: "请求来源不受信任" });
  });

  const setSessionCookie = (reply: FastifyReply, token: string) => {
    reply.setCookie(sessionCookieName, token, {
      path: "/",
      httpOnly: true,
      secure: options.cookieSecure,
      sameSite: options.cookieSameSite || "lax",
      maxAge: COOKIE_MAX_AGE_SECONDS,
    });
  };
  const clearSessionCookie = (reply: FastifyReply) => {
    reply.clearCookie(sessionCookieName, { path: "/", httpOnly: true, secure: options.cookieSecure, sameSite: options.cookieSameSite || "lax" });
  };
  const actionUrl = (parameter: "verify" | "reset" | "invite", token: string) => {
    if (!publicWebUrl) throw new Error("邮件服务尚未启用");
    const url = new URL(publicWebUrl);
    url.searchParams.set(parameter, token);
    return url.toString();
  };
  const team = options.teamStore ? new TeamService(options.teamStore) : undefined;
  const teamError = (reply: FastifyReply, error: unknown, fallback: string) => {
    if (error instanceof TeamAccessError) return reply.code(403).send({ message: error.message });
    if (error instanceof TeamNotFoundError) return reply.code(404).send({ message: error.message });
    if (error instanceof TeamConflictError) return reply.code(409).send({ message: error.message });
    if (error instanceof Error && /团队名称|邀请|成员角色/.test(error.message)) return reply.code(400).send({ message: error.message });
    return reply.code(500).send({ message: fallback });
  };
  const sendEmailVerification = async (userId: string) => {
    if (!options.emailDelivery) return;
    const action = await auth.createEmailVerification(userId);
    if (action) await options.emailDelivery.sendEmailVerification(action.user.email, actionUrl("verify", action.token));
  };

  app.get("/v1/live", async () => ({ ok: true }));

  app.get("/v1/health", async (_request, reply) => {
    try {
      await options.store.health?.();
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  app.get("/v1/auth/session", async (request): Promise<CloudAuthSession> => {
    return await auth.authenticate(request.cookies[sessionCookieName]) || { authenticated: false };
  });

  app.post("/v1/auth/register", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = bodyRecord(request.body);
    try {
      const result = await auth.register({
        email: typeof body.email === "string" ? body.email : "",
        displayName: typeof body.displayName === "string" ? body.displayName : "",
        password: typeof body.password === "string" ? body.password : "",
      });
      setSessionCookie(reply, result.token);
      let verificationDelivery: "sent" | "failed" | undefined;
      if (options.emailDelivery) {
        try {
          await sendEmailVerification(result.session.user.id);
          verificationDelivery = "sent";
        } catch (deliveryError) {
          verificationDelivery = "failed";
          request.log.error(deliveryError);
        }
      }
      return reply.code(201).send({ ...result.session, ...(verificationDelivery ? { verificationDelivery } : {}) });
    } catch (error) {
      if (error instanceof DuplicateEmailError) return reply.code(409).send({ message: error.message });
      if (error instanceof Error && /邮箱|显示名称|密码/.test(error.message)) return reply.code(400).send({ message: error.message });
      request.log.error(error);
      return reply.code(500).send({ message: "暂时无法创建账户" });
    }
  });

  app.post("/v1/auth/email/verify", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const body = bodyRecord(request.body);
    try {
      const result = await auth.verifyEmail(typeof body.token === "string" ? body.token : "");
      if (!result) return reply.code(400).send({ message: "验证链接无效或已经过期" });
      setSessionCookie(reply, result.token);
      return result.session;
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ message: "暂时无法验证邮箱" });
    }
  });

  app.post("/v1/auth/email/resend", { config: { rateLimit: { max: 3, timeWindow: "15 minutes" } } }, async (request, reply) => {
    if (!options.emailDelivery) return reply.code(503).send({ message: "邮件服务尚未启用" });
    const session = await auth.authenticate(request.cookies[sessionCookieName]);
    if (!session) return reply.code(401).send({ message: "请先登录" });
    const csrfToken = request.headers["x-csrf-token"];
    if (!auth.csrfMatches(session, typeof csrfToken === "string" ? csrfToken : undefined)) {
      return reply.code(403).send({ message: "会话校验失败，请刷新后重试" });
    }
    if (session.user.emailVerified) return reply.code(204).send();
    try {
      await sendEmailVerification(session.user.id);
      return reply.code(204).send();
    } catch (error) {
      request.log.error(error);
      return reply.code(503).send({ message: "验证邮件发送失败，请稍后重试" });
    }
  });

  app.post("/v1/auth/password/forgot", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const body = bodyRecord(request.body);
    try {
      const action = await auth.createPasswordReset(typeof body.email === "string" ? body.email : "");
      if (action && options.emailDelivery) {
        await options.emailDelivery.sendPasswordReset(action.user.email, actionUrl("reset", action.token));
      }
    } catch (error) {
      request.log.error(error);
    }
    return reply.code(202).send({ message: "如果该邮箱已注册，重置邮件会很快发出" });
  });

  app.post("/v1/auth/password/reset", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const body = bodyRecord(request.body);
    try {
      const reset = await auth.resetPassword(
        typeof body.token === "string" ? body.token : "",
        typeof body.password === "string" ? body.password : "",
      );
      if (!reset) return reply.code(400).send({ message: "重置链接无效或已经过期" });
      clearSessionCookie(reply);
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof Error && /密码/.test(error.message)) return reply.code(400).send({ message: error.message });
      request.log.error(error);
      return reply.code(500).send({ message: "暂时无法重置密码" });
    }
  });

  app.post("/v1/auth/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = bodyRecord(request.body);
    try {
      const result = await auth.login({
        email: typeof body.email === "string" ? body.email : "",
        password: typeof body.password === "string" ? body.password : "",
      });
      if (!result) return reply.code(401).send({ message: "邮箱或密码不正确" });
      setSessionCookie(reply, result.token);
      return result.session;
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ message: "暂时无法登录" });
    }
  });

  app.get("/v1/account", async (request, reply) => {
    const session = await auth.authenticate(request.cookies[sessionCookieName]);
    if (!session) return reply.code(401).send({ message: "请先登录" });
    return session;
  });

  app.get("/v1/auth/sessions", async (request, reply): Promise<CloudSessionListPayload | FastifyReply> => {
    const session = await auth.authenticate(request.cookies[sessionCookieName]);
    if (!session) return reply.code(401).send({ message: "请先登录" });
    return { sessions: await auth.listSessions(session.user.id, session.tenant.id, session.sessionId) };
  });

  app.delete<{ Params: { id: string } }>("/v1/auth/sessions/:id", async (request, reply) => {
    const session = await auth.authenticate(request.cookies[sessionCookieName]);
    if (!session) return reply.code(401).send({ message: "请先登录" });
    const csrfToken = request.headers["x-csrf-token"];
    if (!auth.csrfMatches(session, typeof csrfToken === "string" ? csrfToken : undefined)) {
      return reply.code(403).send({ message: "会话校验失败，请刷新后重试" });
    }
    if (!uuidPattern.test(request.params.id)) return reply.code(400).send({ message: "会话标识无效" });
    const revoked = await auth.revokeUserSession(session.user.id, session.tenant.id, request.params.id);
    if (!revoked) return reply.code(404).send({ message: "会话不存在" });
    if (request.params.id === session.sessionId) clearSessionCookie(reply);
    return reply.code(204).send();
  });

  app.post("/v1/auth/sessions/revoke-others", async (request, reply) => {
    const session = await auth.authenticate(request.cookies[sessionCookieName]);
    if (!session) return reply.code(401).send({ message: "请先登录" });
    const csrfToken = request.headers["x-csrf-token"];
    if (!auth.csrfMatches(session, typeof csrfToken === "string" ? csrfToken : undefined)) {
      return reply.code(403).send({ message: "会话校验失败，请刷新后重试" });
    }
    const revoked = await auth.revokeOtherSessions(session.user.id, session.tenant.id, session.sessionId);
    return { revoked };
  });

  app.get("/v1/tenants", async (request, reply): Promise<CloudTenantListPayload | FastifyReply> => {
    if (!team) return reply.code(503).send({ message: "团队数据服务尚未启用" });
    const session = await auth.authenticate(request.cookies[sessionCookieName]);
    if (!session) return reply.code(401).send({ message: "请先登录" });
    if (!session.user.emailVerified) return reply.code(403).send({ message: "请先验证邮箱" });
    return { tenants: await team.listTenants(session.user.id) };
  });

  app.post("/v1/tenants", async (request, reply) => {
    if (!team) return reply.code(503).send({ message: "团队数据服务尚未启用" });
    const session = await auth.authenticate(request.cookies[sessionCookieName]);
    if (!session) return reply.code(401).send({ message: "请先登录" });
    if (!session.user.emailVerified) return reply.code(403).send({ message: "请先验证邮箱" });
    const csrfToken = request.headers["x-csrf-token"];
    if (!auth.csrfMatches(session, typeof csrfToken === "string" ? csrfToken : undefined)) {
      return reply.code(403).send({ message: "会话校验失败，请刷新后重试" });
    }
    const body = bodyRecord(request.body);
    try {
      return reply.code(201).send(await team.createTeam(session.user.id, typeof body.name === "string" ? body.name : ""));
    } catch (error) {
      request.log.error(error);
      return teamError(reply, error, "暂时无法创建团队");
    }
  });

  app.post("/v1/auth/tenant", async (request, reply) => {
    if (!team) return reply.code(503).send({ message: "团队数据服务尚未启用" });
    const currentToken = request.cookies[sessionCookieName];
    const session = await auth.authenticate(currentToken);
    if (!session) return reply.code(401).send({ message: "请先登录" });
    if (!session.user.emailVerified) return reply.code(403).send({ message: "请先验证邮箱" });
    const csrfToken = request.headers["x-csrf-token"];
    if (!auth.csrfMatches(session, typeof csrfToken === "string" ? csrfToken : undefined)) {
      return reply.code(403).send({ message: "会话校验失败，请刷新后重试" });
    }
    const body = bodyRecord(request.body);
    const tenantId = typeof body.tenantId === "string" ? body.tenantId : "";
    if (!uuidPattern.test(tenantId)) return reply.code(400).send({ message: "工作区标识无效" });
    if (tenantId === session.tenant.id) return session;
    try {
      await team.assertMembership(session.user.id, tenantId);
      const result = await auth.switchTenant(session.user.id, tenantId, currentToken);
      setSessionCookie(reply, result.token);
      return result.session;
    } catch (error) {
      request.log.error(error);
      return teamError(reply, error, "暂时无法切换工作区");
    }
  });

  app.get("/v1/invitations", async (request, reply): Promise<CloudPendingInvitationsPayload | FastifyReply> => {
    if (!team) return reply.code(503).send({ message: "团队数据服务尚未启用" });
    const session = await auth.authenticate(request.cookies[sessionCookieName]);
    if (!session) return reply.code(401).send({ message: "请先登录" });
    if (!session.user.emailVerified) return reply.code(403).send({ message: "请先验证邮箱" });
    return { invitations: await team.listMine(session.user.id, session.user.email) };
  });

  app.post("/v1/invitations/accept", async (request, reply) => {
    if (!team) return reply.code(503).send({ message: "团队数据服务尚未启用" });
    const session = await auth.authenticate(request.cookies[sessionCookieName]);
    if (!session) return reply.code(401).send({ message: "请先登录" });
    if (!session.user.emailVerified) return reply.code(403).send({ message: "请先验证邮箱" });
    const csrfToken = request.headers["x-csrf-token"];
    if (!auth.csrfMatches(session, typeof csrfToken === "string" ? csrfToken : undefined)) {
      return reply.code(403).send({ message: "会话校验失败，请刷新后重试" });
    }
    const body = bodyRecord(request.body);
    const invitationId = typeof body.invitationId === "string" ? body.invitationId : undefined;
    const inviteToken = typeof body.token === "string" ? body.token : undefined;
    if (invitationId && !uuidPattern.test(invitationId)) return reply.code(400).send({ message: "邀请标识无效" });
    if (inviteToken && !/^[A-Za-z0-9_-]{40,128}$/.test(inviteToken)) return reply.code(400).send({ message: "邀请标识无效" });
    try {
      return await team.accept(session.user.id, session.user.email, { invitationId, token: inviteToken });
    } catch (error) {
      request.log.error(error);
      return teamError(reply, error, "暂时无法接受邀请");
    }
  });

  app.get("/v1/team", async (request, reply) => {
    if (!team) return reply.code(503).send({ message: "团队数据服务尚未启用" });
    const session = await auth.authenticate(request.cookies[sessionCookieName]);
    if (!session) return reply.code(401).send({ message: "请先登录" });
    if (!session.user.emailVerified) return reply.code(403).send({ message: "请先验证邮箱" });
    try {
      return await team.overview({ tenantId: session.tenant.id, userId: session.user.id });
    } catch (error) {
      request.log.error(error);
      return teamError(reply, error, "暂时无法读取团队成员");
    }
  });

  app.post("/v1/team/invitations", async (request, reply) => {
    if (!team) return reply.code(503).send({ message: "团队数据服务尚未启用" });
    const session = await auth.authenticate(request.cookies[sessionCookieName]);
    if (!session) return reply.code(401).send({ message: "请先登录" });
    if (!session.user.emailVerified) return reply.code(403).send({ message: "请先验证邮箱" });
    const csrfToken = request.headers["x-csrf-token"];
    if (!auth.csrfMatches(session, typeof csrfToken === "string" ? csrfToken : undefined)) {
      return reply.code(403).send({ message: "会话校验失败，请刷新后重试" });
    }
    const body = bodyRecord(request.body);
    try {
      const created = await team.invite(
        { tenantId: session.tenant.id, userId: session.user.id },
        typeof body.email === "string" ? body.email : "",
        typeof body.role === "string" ? body.role : "",
      );
      let delivery: "sent" | "failed" | "unavailable" = "unavailable";
      if (options.emailDelivery) {
        try {
          await options.emailDelivery.sendTenantInvitation(
            created.invitation.email,
            created.tenantName,
            created.invitation.invitedByName,
            actionUrl("invite", created.token),
          );
          delivery = "sent";
        } catch (deliveryError) {
          delivery = "failed";
          request.log.error(deliveryError);
        }
      }
      return reply.code(201).send({ invitation: created.invitation, delivery });
    } catch (error) {
      request.log.error(error);
      return teamError(reply, error, "暂时无法发送邀请");
    }
  });

  app.delete<{ Params: { id: string } }>("/v1/team/invitations/:id", async (request, reply) => {
    if (!team) return reply.code(503).send({ message: "团队数据服务尚未启用" });
    const session = await auth.authenticate(request.cookies[sessionCookieName]);
    if (!session) return reply.code(401).send({ message: "请先登录" });
    if (!session.user.emailVerified) return reply.code(403).send({ message: "请先验证邮箱" });
    const csrfToken = request.headers["x-csrf-token"];
    if (!auth.csrfMatches(session, typeof csrfToken === "string" ? csrfToken : undefined)) return reply.code(403).send({ message: "会话校验失败，请刷新后重试" });
    if (!uuidPattern.test(request.params.id)) return reply.code(400).send({ message: "邀请标识无效" });
    try {
      const revoked = await team.revoke({ tenantId: session.tenant.id, userId: session.user.id }, request.params.id);
      return revoked ? reply.code(204).send() : reply.code(404).send({ message: "邀请不存在" });
    } catch (error) {
      request.log.error(error);
      return teamError(reply, error, "暂时无法撤销邀请");
    }
  });

  app.patch<{ Params: { userId: string } }>("/v1/team/members/:userId", async (request, reply) => {
    if (!team) return reply.code(503).send({ message: "团队数据服务尚未启用" });
    const session = await auth.authenticate(request.cookies[sessionCookieName]);
    if (!session) return reply.code(401).send({ message: "请先登录" });
    if (!session.user.emailVerified) return reply.code(403).send({ message: "请先验证邮箱" });
    const csrfToken = request.headers["x-csrf-token"];
    if (!auth.csrfMatches(session, typeof csrfToken === "string" ? csrfToken : undefined)) return reply.code(403).send({ message: "会话校验失败，请刷新后重试" });
    if (!uuidPattern.test(request.params.userId)) return reply.code(400).send({ message: "成员标识无效" });
    const body = bodyRecord(request.body);
    try {
      const updated = await team.changeRole(
        { tenantId: session.tenant.id, userId: session.user.id },
        request.params.userId,
        typeof body.role === "string" ? body.role : "",
      );
      return updated ? reply.code(204).send() : reply.code(404).send({ message: "成员不存在" });
    } catch (error) {
      request.log.error(error);
      return teamError(reply, error, "暂时无法调整成员角色");
    }
  });

  app.delete<{ Params: { userId: string } }>("/v1/team/members/:userId", async (request, reply) => {
    if (!team) return reply.code(503).send({ message: "团队数据服务尚未启用" });
    const session = await auth.authenticate(request.cookies[sessionCookieName]);
    if (!session) return reply.code(401).send({ message: "请先登录" });
    if (!session.user.emailVerified) return reply.code(403).send({ message: "请先验证邮箱" });
    const csrfToken = request.headers["x-csrf-token"];
    if (!auth.csrfMatches(session, typeof csrfToken === "string" ? csrfToken : undefined)) return reply.code(403).send({ message: "会话校验失败，请刷新后重试" });
    if (!uuidPattern.test(request.params.userId)) return reply.code(400).send({ message: "成员标识无效" });
    try {
      const removed = await team.remove({ tenantId: session.tenant.id, userId: session.user.id }, request.params.userId);
      return removed ? reply.code(204).send() : reply.code(404).send({ message: "成员不存在" });
    } catch (error) {
      request.log.error(error);
      return teamError(reply, error, "暂时无法移除成员");
    }
  });

  app.get<{ Querystring: { kind?: string } }>("/v1/tenant/resources", async (request, reply) => {
    if (!options.tenantStore) return reply.code(503).send({ message: "租户数据服务尚未启用" });
    const session = await auth.authenticate(request.cookies[sessionCookieName]);
    if (!session) return reply.code(401).send({ message: "请先登录" });
    if (!session.user.emailVerified) return reply.code(403).send({ message: "请先验证邮箱" });
    const kind = request.query.kind === undefined ? undefined : tenantResourceKind(request.query.kind);
    if (request.query.kind !== undefined && !kind) return reply.code(400).send({ message: "租户资源类型无效" });
    try {
      const resources = await options.tenantStore.listResources({ tenantId: session.tenant.id, userId: session.user.id }, kind);
      return { tenantId: session.tenant.id, resources };
    } catch (error) {
      if (error instanceof TenantAccessError) return reply.code(403).send({ message: error.message });
      request.log.error(error);
      return reply.code(500).send({ message: "暂时无法读取租户数据" });
    }
  });

  app.put<{ Params: { kind: string; key: string }; Body: { payload?: unknown; expectedVersion?: number } }>("/v1/tenant/resources/:kind/:key", async (request, reply) => {
    if (!options.tenantStore) return reply.code(503).send({ message: "租户数据服务尚未启用" });
    const session = await auth.authenticate(request.cookies[sessionCookieName]);
    if (!session) return reply.code(401).send({ message: "请先登录" });
    if (!session.user.emailVerified) return reply.code(403).send({ message: "请先验证邮箱" });
    const csrfToken = request.headers["x-csrf-token"];
    if (!auth.csrfMatches(session, typeof csrfToken === "string" ? csrfToken : undefined)) {
      return reply.code(403).send({ message: "会话校验失败，请刷新后重试" });
    }
    const kind = tenantResourceKind(request.params.kind);
    if (!kind) return reply.code(400).send({ message: "租户资源类型无效" });
    const expectedVersion = request.body?.expectedVersion;
    if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)) {
      return reply.code(400).send({ message: "云端资源版本无效" });
    }
    try {
      const resource = await options.tenantStore.upsertResource(
        { tenantId: session.tenant.id, userId: session.user.id },
        { kind, key: tenantResourceKey(request.params.key), payload: tenantResourcePayload(kind, request.body?.payload), expectedVersion },
      );
      return resource;
    } catch (error) {
      if (error instanceof TenantAccessError) return reply.code(403).send({ message: error.message });
      if (error instanceof TenantVersionConflictError) return reply.code(409).send({ message: error.message, current: error.current });
      if (error instanceof Error && /租户资源/.test(error.message)) return reply.code(400).send({ message: error.message });
      request.log.error(error);
      return reply.code(500).send({ message: "暂时无法保存租户数据" });
    }
  });

  app.delete<{ Params: { kind: string; key: string } }>("/v1/tenant/resources/:kind/:key", async (request, reply) => {
    if (!options.tenantStore) return reply.code(503).send({ message: "租户数据服务尚未启用" });
    const session = await auth.authenticate(request.cookies[sessionCookieName]);
    if (!session) return reply.code(401).send({ message: "请先登录" });
    if (!session.user.emailVerified) return reply.code(403).send({ message: "请先验证邮箱" });
    const csrfToken = request.headers["x-csrf-token"];
    if (!auth.csrfMatches(session, typeof csrfToken === "string" ? csrfToken : undefined)) {
      return reply.code(403).send({ message: "会话校验失败，请刷新后重试" });
    }
    const kind = tenantResourceKind(request.params.kind);
    if (!kind) return reply.code(400).send({ message: "租户资源类型无效" });
    try {
      const deleted = await options.tenantStore.deleteResource(
        { tenantId: session.tenant.id, userId: session.user.id }, kind, tenantResourceKey(request.params.key),
      );
      return deleted ? reply.code(204).send() : reply.code(404).send({ message: "租户资源不存在" });
    } catch (error) {
      if (error instanceof TenantAccessError) return reply.code(403).send({ message: error.message });
      if (error instanceof Error && /租户资源/.test(error.message)) return reply.code(400).send({ message: error.message });
      request.log.error(error);
      return reply.code(500).send({ message: "暂时无法删除租户数据" });
    }
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    const token = request.cookies[sessionCookieName];
    const session = await auth.authenticate(token);
    if (!session) {
      clearSessionCookie(reply);
      return reply.code(204).send();
    }
    const csrfToken = request.headers["x-csrf-token"];
    if (!auth.csrfMatches(session, typeof csrfToken === "string" ? csrfToken : undefined)) {
      return reply.code(403).send({ message: "会话校验失败，请刷新后重试" });
    }
    await auth.logout(token);
    clearSessionCookie(reply);
    return reply.code(204).send();
  });

  app.addHook("onClose", async () => options.store.close?.());
  return app;
}
