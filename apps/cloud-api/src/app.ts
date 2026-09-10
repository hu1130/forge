import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyReply } from "fastify";
import type { CloudAuthSession } from "@forge/contracts";
import { AuthService, DuplicateEmailError, type AuthStore } from "./auth-service.js";

export interface CloudApiOptions {
  store: AuthStore;
  allowedOrigins: string[];
  cookieSecure: boolean;
  cookieSameSite?: "lax" | "none";
}

const COOKIE_NAME = "forge_cloud_session";
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function bodyRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function createCloudApi(options: CloudApiOptions) {
  if (options.cookieSameSite === "none" && !options.cookieSecure) {
    throw new Error("SameSite=None requires secure cookies");
  }
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 });
  const auth = new AuthService(options.store);
  await app.register(cookie);
  await app.register(cors, { origin: options.allowedOrigins, credentials: true });
  await app.register(rateLimit, { global: false });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("cache-control", "no-store");
    if (!unsafeMethods.has(request.method)) return;
    const fetchSite = request.headers["sec-fetch-site"];
    if (fetchSite === "cross-site") return reply.code(403).send({ message: "跨站请求已拒绝" });
    const origin = request.headers.origin;
    if (origin && !options.allowedOrigins.includes(origin)) return reply.code(403).send({ message: "请求来源不受信任" });
  });

  const setSessionCookie = (reply: FastifyReply, token: string) => {
    reply.setCookie(COOKIE_NAME, token, {
      path: "/",
      httpOnly: true,
      secure: options.cookieSecure,
      sameSite: options.cookieSameSite || "lax",
      maxAge: COOKIE_MAX_AGE_SECONDS,
    });
  };
  const clearSessionCookie = (reply: FastifyReply) => {
    reply.clearCookie(COOKIE_NAME, { path: "/", httpOnly: true, secure: options.cookieSecure, sameSite: options.cookieSameSite || "lax" });
  };

  app.get("/v1/health", async (_request, reply) => {
    try {
      await options.store.health?.();
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  app.get("/v1/auth/session", async (request): Promise<CloudAuthSession> => {
    return await auth.authenticate(request.cookies[COOKIE_NAME]) || { authenticated: false };
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
      return reply.code(201).send(result.session);
    } catch (error) {
      if (error instanceof DuplicateEmailError) return reply.code(409).send({ message: error.message });
      if (error instanceof Error && /邮箱|显示名称|密码/.test(error.message)) return reply.code(400).send({ message: error.message });
      request.log.error(error);
      return reply.code(500).send({ message: "暂时无法创建账户" });
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
    const session = await auth.authenticate(request.cookies[COOKIE_NAME]);
    if (!session) return reply.code(401).send({ message: "请先登录" });
    return session;
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    const token = request.cookies[COOKIE_NAME];
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
