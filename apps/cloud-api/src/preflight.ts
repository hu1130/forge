import { loadCloudDeploymentConfig } from "./deployment-config.js";

try {
  const config = loadCloudDeploymentConfig();
  const runtimeDatabase = new URL(config.databaseUrl);
  const migrationDatabase = new URL(config.migrationDatabaseUrl);
  console.log(JSON.stringify({
    ok: true,
    mode: config.production ? "production" : "development",
    host: config.host,
    port: config.port,
    origins: config.allowedOrigins,
    publicWebUrl: config.publicWebUrl,
    database: "mysql",
    runtimeAndMigrationAccountsSeparated: runtimeDatabase.username !== migrationDatabase.username,
    emailDelivery: Boolean(config.resendApiKey && config.emailFrom),
  }));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Cloud 部署配置检查失败");
  process.exitCode = 1;
}
