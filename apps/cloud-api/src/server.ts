import { Pool } from "pg";
import { createCloudApi } from "./app.js";
import { migrateDatabase, PostgresAuthStore } from "./postgres-store.js";

const databaseUrl = process.env.DATABASE_URL?.trim()
  || (process.env.NODE_ENV === "production" ? "" : "postgresql://forge:forge_dev_only@127.0.0.1:54329/forge");
if (!databaseUrl) throw new Error("生产环境的 Cloud API 需要 DATABASE_URL，未自动降级到本地文件数据库");

const host = process.env.FORGE_CLOUD_HOST || "127.0.0.1";
const port = Number(process.env.FORGE_CLOUD_PORT || 4790);
const allowedOrigins = (process.env.FORGE_CLOUD_ORIGINS || "http://127.0.0.1:5173,http://localhost:5173")
  .split(",").map((origin) => origin.trim()).filter(Boolean);
const pool = new Pool({ connectionString: databaseUrl, max: Number(process.env.FORGE_CLOUD_DB_POOL_SIZE || 10) });
await migrateDatabase(pool);
const app = await createCloudApi({
  store: new PostgresAuthStore(pool),
  allowedOrigins,
  cookieSecure: process.env.NODE_ENV === "production",
  cookieSameSite: process.env.FORGE_CLOUD_COOKIE_SAMESITE === "none" ? "none" : "lax",
});

await app.listen({ host, port });
console.log(`Forge Cloud API: http://${host}:${port}`);

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
