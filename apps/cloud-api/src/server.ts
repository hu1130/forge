import { createCloudApi } from "./app.js";
import { loadCloudDeploymentConfig } from "./deployment-config.js";
import { ConsoleEmailDelivery, ResendEmailDelivery } from "./email-delivery.js";
import { createForgeMySqlPool, migrateDatabase, MySqlAuthStore } from "./mysql-store.js";

const config = loadCloudDeploymentConfig();
const emailDelivery = config.resendApiKey && config.emailFrom
  ? new ResendEmailDelivery({ apiKey: config.resendApiKey, from: config.emailFrom })
  : new ConsoleEmailDelivery();
const migrationPool = createForgeMySqlPool(config.migrationDatabaseUrl, 1);
try {
  await migrateDatabase(migrationPool);
} finally {
  await migrationPool.end();
}
const pool = createForgeMySqlPool(config.databaseUrl, config.databasePoolSize);
const store = new MySqlAuthStore(pool);
const app = await createCloudApi({
  store,
  tenantStore: store,
  allowedOrigins: config.allowedOrigins,
  cookieSecure: config.production,
  cookieSameSite: config.cookieSameSite,
  emailDelivery,
  publicWebUrl: config.publicWebUrl,
  trustProxy: config.trustProxy,
  requireOriginForUnsafeRequests: config.production,
  logger: config.production ? {
    level: config.logLevel,
    base: { service: "forge-cloud-api", version: "0.18.0" },
    redact: { paths: ["req.headers.cookie", "req.headers.authorization", "res.headers['set-cookie']"], censor: "[REDACTED]" },
  } : false,
});

await app.listen({ host: config.host, port: config.port });
console.log(`Forge Cloud API: http://${config.host}:${config.port}`);

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
