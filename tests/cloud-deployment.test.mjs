import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createCloudApi } from "../apps/cloud-api/dist/app.js";
import { loadCloudDeploymentConfig } from "../apps/cloud-api/dist/deployment-config.js";

const productionEnvironment = () => ({
  NODE_ENV: "production",
  DATABASE_URL: "mysql://forge_app:runtime-secret@example.internal:3306/forge",
  FORGE_CLOUD_MIGRATION_DATABASE_URL: "mysql://forge_migrator:migration-secret@example.internal:3306/forge",
  FORGE_CLOUD_ORIGINS: "https://forge.example.com",
  FORGE_CLOUD_PUBLIC_WEB_URL: "https://forge.example.com/?cloud=1",
  FORGE_CLOUD_RESEND_API_KEY: "re_test_only",
  FORGE_CLOUD_EMAIL_FROM: "Forge <no-reply@example.com>",
  FORGE_CLOUD_TRUST_PROXY: "1",
});

test("production deployment configuration accepts only separated MySQL credentials and HTTPS origins", () => {
  const config = loadCloudDeploymentConfig(productionEnvironment());
  assert.equal(config.production, true);
  assert.equal(config.databasePoolSize, 10);
  assert.deepEqual(config.allowedOrigins, ["https://forge.example.com"]);

  const desktopConfig = loadCloudDeploymentConfig({
    ...productionEnvironment(),
    FORGE_CLOUD_ORIGINS: "https://forge.example.com,http://127.0.0.1:4782",
    FORGE_CLOUD_COOKIE_SAMESITE: "none",
  });
  assert.deepEqual(desktopConfig.allowedOrigins, ["https://forge.example.com", "http://127.0.0.1:4782"]);
  assert.equal(desktopConfig.cookieSameSite, "none");
  assert.throws(() => loadCloudDeploymentConfig({
    ...productionEnvironment(),
    FORGE_CLOUD_ORIGINS: "https://forge.example.com,http://127.0.0.1:4782",
  }), /COOKIE_SAMESITE=none/);

  assert.throws(() => loadCloudDeploymentConfig({
    ...productionEnvironment(),
    DATABASE_URL: "postgresql://forge_app:runtime-secret@example.internal/forge",
  }), /mysql/);
  assert.throws(() => loadCloudDeploymentConfig({
    ...productionEnvironment(),
    FORGE_CLOUD_MIGRATION_DATABASE_URL: "mysql://forge_app:migration-secret@example.internal/forge",
  }), /运行账号和迁移账号必须不同/);
  assert.throws(() => loadCloudDeploymentConfig({
    ...productionEnvironment(),
    FORGE_CLOUD_ORIGINS: "http://forge.example.com",
  }), /https/i);
  assert.throws(() => loadCloudDeploymentConfig({
    ...productionEnvironment(),
    FORGE_CLOUD_PUBLIC_WEB_URL: "https://account.example.com/?cloud=1",
  }), /必须包含在 FORGE_CLOUD_ORIGINS/);
  assert.throws(() => loadCloudDeploymentConfig({
    ...productionEnvironment(),
    DATABASE_URL: "mysql://forge_app:forge_app_dev_only@example.internal/forge",
  }), /开发数据库密码/);
  assert.throws(() => loadCloudDeploymentConfig({
    ...productionEnvironment(),
    FORGE_CLOUD_TRUST_PROXY: "0",
  }), /可信 HTTPS 反向代理/);
});

test("liveness stays available while readiness reports a database outage", async () => {
  const store = {
    health: async () => { throw new Error("database unavailable"); },
    close: async () => undefined,
  };
  const app = await createCloudApi({ store, allowedOrigins: ["http://127.0.0.1:5173"], cookieSecure: false });
  try {
    const live = await app.inject({ method: "GET", url: "/v1/live" });
    assert.equal(live.statusCode, 200);
    assert.deepEqual(live.json(), { ok: true });
    assert.equal(typeof live.headers["x-request-id"], "string");
    const ready = await app.inject({ method: "GET", url: "/v1/health" });
    assert.equal(ready.statusCode, 503);
    assert.deepEqual(ready.json(), { ok: false });
  } finally {
    await app.close();
  }
});

test("MySQL maintenance keeps credentials out of argv and protects restore with explicit confirmation", async () => {
  const source = await readFile("scripts/mysql-maintenance.mjs", "utf8");
  assert.match(source, /--defaults-extra-file=/);
  assert.doesNotMatch(source, /MYSQL_PWD/);
  assert.doesNotMatch(source, /"--databases"/);
  assert.doesNotMatch(source, /["']--databases["']/);

  const help = spawnSync(process.execPath, ["scripts/mysql-maintenance.mjs", "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /FORGE_CLOUD_BACKUP_DATABASE_URL/);

  const password = "maintenance-secret-not-for-logs";
  const rejected = spawnSync(process.execPath, ["scripts/mysql-maintenance.mjs", "restore", "missing.sql.gz"], {
    encoding: "utf8",
    env: { ...process.env, FORGE_CLOUD_RESTORE_DATABASE_URL: `mysql://restore:${password}@127.0.0.1:3306/forge` },
  });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /--confirm=forge/);
  assert.doesNotMatch(`${rejected.stdout}${rejected.stderr}`, new RegExp(password));
});
