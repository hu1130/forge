export interface CloudDeploymentConfig {
  production: boolean;
  databaseUrl: string;
  migrationDatabaseUrl: string;
  host: string;
  port: number;
  databasePoolSize: number;
  allowedOrigins: string[];
  publicWebUrl: string;
  resendApiKey: string;
  emailFrom: string;
  trustProxy: boolean;
  cookieSameSite: "lax" | "none";
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
}

const developmentPasswords = new Set(["forge_dev_only", "forge_app_dev_only", "forge_root_dev_only"]);
const logLevels = new Set<CloudDeploymentConfig["logLevel"]>(["fatal", "error", "warn", "info", "debug", "trace"]);

function requiredUrl(name: string, value: string, protocol: "mysql:" | "https:" | "http:") {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} 不是有效 URL`);
  }
  if (parsed.protocol !== protocol) throw new Error(`${name} 必须使用 ${protocol.slice(0, -1)} 协议`);
  return parsed;
}

function mysqlConnection(name: string, value: string) {
  const parsed = requiredUrl(name, value, "mysql:");
  if (!parsed.hostname || !parsed.username || !parsed.password || parsed.pathname === "/") {
    throw new Error(`${name} 必须包含数据库地址、账号、密码和数据库名`);
  }
  return parsed;
}

function exactOrigin(name: string, value: string, production: boolean) {
  const protocol = production || value.startsWith("https:") ? "https:" : "http:";
  const parsed = requiredUrl(name, value, protocol);
  if (parsed.username || parsed.password || parsed.origin !== value) throw new Error(`${name} 必须是没有路径、查询或凭据的来源地址`);
  return parsed.origin;
}

function integerSetting(name: string, value: string, minimum: number, maximum: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name} 无效`);
  return parsed;
}

export function loadCloudDeploymentConfig(environment: NodeJS.ProcessEnv = process.env): CloudDeploymentConfig {
  const production = environment.NODE_ENV === "production";
  const databaseUrl = environment.DATABASE_URL?.trim()
    || (production ? "" : "mysql://forge_app:forge_app_dev_only@127.0.0.1:33069/forge");
  if (!databaseUrl) throw new Error("生产环境的 Cloud API 需要 DATABASE_URL，未自动降级到本地文件数据库");
  const migrationDatabaseUrl = environment.FORGE_CLOUD_MIGRATION_DATABASE_URL?.trim()
    || (production ? "" : "mysql://forge_migrator:forge_dev_only@127.0.0.1:33069/forge");
  if (!migrationDatabaseUrl) throw new Error("生产环境的 Cloud API 需要独立的 FORGE_CLOUD_MIGRATION_DATABASE_URL");
  const runtimeDatabase = mysqlConnection("DATABASE_URL", databaseUrl);
  const migrationDatabase = mysqlConnection("FORGE_CLOUD_MIGRATION_DATABASE_URL", migrationDatabaseUrl);
  if (runtimeDatabase.pathname !== migrationDatabase.pathname) throw new Error("运行账号和迁移账号必须连接同一个数据库");

  const host = environment.FORGE_CLOUD_HOST || (production ? "0.0.0.0" : "127.0.0.1");
  const port = integerSetting("FORGE_CLOUD_PORT", environment.FORGE_CLOUD_PORT || "4790", 1, 65_535);
  const databasePoolSize = integerSetting("FORGE_CLOUD_DB_POOL_SIZE", environment.FORGE_CLOUD_DB_POOL_SIZE || "10", 1, 100);
  const originValues = (environment.FORGE_CLOUD_ORIGINS || "http://127.0.0.1:5173,http://localhost:5173")
    .split(",").map((origin) => origin.trim()).filter(Boolean);
  if (!originValues.length || originValues.includes("*")) throw new Error("FORGE_CLOUD_ORIGINS 必须列出明确来源，不能使用通配符");
  const allowedOrigins = [...new Set(originValues.map((origin) => exactOrigin("FORGE_CLOUD_ORIGINS", origin, production)))];
  const publicWebUrl = environment.FORGE_CLOUD_PUBLIC_WEB_URL?.trim() || (production ? "" : "http://127.0.0.1:5173/?cloud=1");
  const resendApiKey = environment.FORGE_CLOUD_RESEND_API_KEY?.trim() || "";
  const emailFrom = environment.FORGE_CLOUD_EMAIL_FROM?.trim() || "";
  const trustProxy = environment.FORGE_CLOUD_TRUST_PROXY === "1";
  const requestedSameSite = environment.FORGE_CLOUD_COOKIE_SAMESITE?.trim() || "lax";
  if (requestedSameSite !== "lax" && requestedSameSite !== "none") throw new Error("FORGE_CLOUD_COOKIE_SAMESITE 无效");
  const cookieSameSite = requestedSameSite;
  const requestedLogLevel = environment.FORGE_CLOUD_LOG_LEVEL?.trim() || "info";
  if (!logLevels.has(requestedLogLevel as CloudDeploymentConfig["logLevel"])) throw new Error("FORGE_CLOUD_LOG_LEVEL 无效");
  const logLevel = requestedLogLevel as CloudDeploymentConfig["logLevel"];

  if (Boolean(resendApiKey) !== Boolean(emailFrom)) {
    throw new Error("FORGE_CLOUD_RESEND_API_KEY 和 FORGE_CLOUD_EMAIL_FROM 必须同时配置");
  }
  if (publicWebUrl) {
    const protocol = production || publicWebUrl.startsWith("https:") ? "https:" : "http:";
    const publicWeb = requiredUrl("FORGE_CLOUD_PUBLIC_WEB_URL", publicWebUrl, protocol);
    if (publicWeb.username || publicWeb.password) throw new Error("FORGE_CLOUD_PUBLIC_WEB_URL 不能包含凭据");
    if (production && !allowedOrigins.includes(publicWeb.origin)) {
      throw new Error("FORGE_CLOUD_PUBLIC_WEB_URL 的来源必须包含在 FORGE_CLOUD_ORIGINS 中");
    }
  }

  if (production) {
    if (!publicWebUrl) throw new Error("生产环境需要 HTTPS 的 FORGE_CLOUD_PUBLIC_WEB_URL");
    if (runtimeDatabase.username === migrationDatabase.username) throw new Error("生产环境的运行账号和迁移账号必须不同");
    if (runtimeDatabase.username.toLowerCase() === "root" || migrationDatabase.username.toLowerCase() === "root") {
      throw new Error("生产环境的数据库账号不能使用 root");
    }
    if (developmentPasswords.has(runtimeDatabase.password) || developmentPasswords.has(migrationDatabase.password)) {
      throw new Error("生产环境不能使用仓库中的开发数据库密码");
    }
    if (!resendApiKey || !emailFrom) throw new Error("生产环境需要 FORGE_CLOUD_RESEND_API_KEY 和 FORGE_CLOUD_EMAIL_FROM");
    if (!trustProxy) throw new Error("生产环境必须在可信 HTTPS 反向代理后设置 FORGE_CLOUD_TRUST_PROXY=1");
  }

  return {
    production, databaseUrl, migrationDatabaseUrl, host, port, databasePoolSize,
    allowedOrigins, publicWebUrl, resendApiKey, emailFrom, trustProxy, cookieSameSite, logLevel,
  };
}
