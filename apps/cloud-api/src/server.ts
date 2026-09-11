import { Pool } from "pg";
import { createCloudApi } from "./app.js";
import { ConsoleEmailDelivery, ResendEmailDelivery } from "./email-delivery.js";
import { migrateDatabase, PostgresAuthStore } from "./postgres-store.js";

const production = process.env.NODE_ENV === "production";
const databaseUrl = process.env.DATABASE_URL?.trim()
  || (production ? "" : "postgresql://forge_app:forge_app_dev_only@127.0.0.1:54329/forge");
if (!databaseUrl) throw new Error("生产环境的 Cloud API 需要 DATABASE_URL，未自动降级到本地文件数据库");
const migrationDatabaseUrl = process.env.FORGE_CLOUD_MIGRATION_DATABASE_URL?.trim()
  || (production ? "" : "postgresql://forge:forge_dev_only@127.0.0.1:54329/forge");
if (!migrationDatabaseUrl) throw new Error("生产环境的 Cloud API 需要独立的 FORGE_CLOUD_MIGRATION_DATABASE_URL");

const host = process.env.FORGE_CLOUD_HOST || (production ? "0.0.0.0" : "127.0.0.1");
const port = Number(process.env.FORGE_CLOUD_PORT || 4790);
const allowedOrigins = (process.env.FORGE_CLOUD_ORIGINS || "http://127.0.0.1:5173,http://localhost:5173")
  .split(",").map((origin) => origin.trim()).filter(Boolean);
const publicWebUrl = process.env.FORGE_CLOUD_PUBLIC_WEB_URL?.trim() || (production ? "" : "http://127.0.0.1:5173/?cloud=1");
const resendApiKey = process.env.FORGE_CLOUD_RESEND_API_KEY?.trim() || "";
const emailFrom = process.env.FORGE_CLOUD_EMAIL_FROM?.trim() || "";
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("FORGE_CLOUD_PORT 无效");
if (!allowedOrigins.length || allowedOrigins.includes("*")) throw new Error("FORGE_CLOUD_ORIGINS 必须列出明确来源，不能使用通配符");
if (production && allowedOrigins.some((origin) => !origin.startsWith("https://"))) throw new Error("生产环境的 FORGE_CLOUD_ORIGINS 必须使用 HTTPS");
if (production && !publicWebUrl.startsWith("https://")) throw new Error("生产环境需要 HTTPS 的 FORGE_CLOUD_PUBLIC_WEB_URL");
if (production && (!resendApiKey || !emailFrom)) throw new Error("生产环境需要 FORGE_CLOUD_RESEND_API_KEY 和 FORGE_CLOUD_EMAIL_FROM");
const emailDelivery = resendApiKey && emailFrom
  ? new ResendEmailDelivery({ apiKey: resendApiKey, from: emailFrom })
  : new ConsoleEmailDelivery();
const migrationPool = new Pool({ connectionString: migrationDatabaseUrl, max: 1 });
try {
  await migrateDatabase(migrationPool);
} finally {
  await migrationPool.end();
}
const pool = new Pool({ connectionString: databaseUrl, max: Number(process.env.FORGE_CLOUD_DB_POOL_SIZE || 10) });
const store = new PostgresAuthStore(pool);
const app = await createCloudApi({
  store,
  tenantStore: store,
  allowedOrigins,
  cookieSecure: process.env.NODE_ENV === "production",
  cookieSameSite: process.env.FORGE_CLOUD_COOKIE_SAMESITE === "none" ? "none" : "lax",
  emailDelivery,
  publicWebUrl,
  trustProxy: process.env.FORGE_CLOUD_TRUST_PROXY === "1",
  logger: production,
});

await app.listen({ host, port });
console.log(`Forge Cloud API: http://${host}:${port}`);

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
