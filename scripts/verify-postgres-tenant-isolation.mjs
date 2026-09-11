import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { migrateDatabase, PostgresAuthStore } from "../apps/cloud-api/dist/postgres-store.js";

const require = createRequire(new URL("../apps/cloud-api/package.json", import.meta.url));
const { Pool } = require("pg");

const appUrl = process.env.FORGE_TEST_POSTGRES_URL || "postgresql://forge_app:forge_app_dev_only@127.0.0.1:54329/forge";
const migrationUrl = process.env.FORGE_TEST_POSTGRES_MIGRATION_URL || "postgresql://forge:forge_dev_only@127.0.0.1:54329/forge";
const adminPool = new Pool({ connectionString: migrationUrl, max: 1 });
const appPool = new Pool({ connectionString: appUrl, max: 2 });
const store = new PostgresAuthStore(appPool);

const accountA = { userId: randomUUID(), tenantId: randomUUID(), email: `rls-a-${randomUUID()}@example.test` };
const accountB = { userId: randomUUID(), tenantId: randomUUID(), email: `rls-b-${randomUUID()}@example.test` };

async function createAccount(account, label, emailVerifiedAt) {
  await store.createAccount({
    ...account,
    displayName: label,
    passwordHash: "test-only-not-a-login-hash",
    emailVerifiedAt,
    tenantName: `${label} workspace`,
    tenantSlug: `${label.toLowerCase()}-${account.tenantId.slice(0, 8)}`,
  });
}

try {
  await migrateDatabase(adminPool);
  await migrateDatabase(adminPool);
  const appliedMigrations = await adminPool.query("SELECT name FROM forge_schema_migrations ORDER BY name");
  assert.deepEqual(appliedMigrations.rows.map((row) => row.name), ["001_identity.sql", "002_tenant_resources.sql", "003_account_security.sql"]);
  await createAccount(accountA, "RLSA", new Date().toISOString());
  await createAccount(accountB, "RLSB");
  const principalA = { tenantId: accountA.tenantId, userId: accountA.userId };
  const principalB = { tenantId: accountB.tenantId, userId: accountB.userId };

  const verificationHash = "a".repeat(64);
  await store.createActionToken({
    id: randomUUID(), userId: accountB.userId, purpose: "verify_email",
    tokenHash: verificationHash, expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal((await store.verifyEmailWithToken(verificationHash)).email, accountB.email);
  assert.equal(await store.verifyEmailWithToken(verificationHash), undefined);

  const firstSessionId = randomUUID();
  const secondSessionId = randomUUID();
  const foreignSessionId = randomUUID();
  const sessionInput = (id, userId, tenantId, tokenHash) => ({
    id, userId, tenantId, tokenHash, csrfToken: randomUUID(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await store.createSession(sessionInput(firstSessionId, accountA.userId, accountA.tenantId, "b".repeat(64)));
  await store.createSession(sessionInput(secondSessionId, accountA.userId, accountA.tenantId, "c".repeat(64)));
  await store.createSession(sessionInput(foreignSessionId, accountB.userId, accountB.tenantId, "d".repeat(64)));
  assert.deepEqual(new Set((await store.listSessions(accountA.userId)).map((session) => session.id)), new Set([firstSessionId, secondSessionId]));
  assert.equal(await store.revokeUserSession(accountA.userId, foreignSessionId), false);
  assert.equal(await store.revokeOtherSessions(accountA.userId, firstSessionId), 1);
  assert.deepEqual((await store.listSessions(accountA.userId)).map((session) => session.id), [firstSessionId]);

  const resetHash = "e".repeat(64);
  await store.createActionToken({
    id: randomUUID(), userId: accountA.userId, purpose: "reset_password",
    tokenHash: resetHash, expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(await store.resetPasswordWithToken(resetHash, "replacement-test-hash"), true);
  assert.equal((await store.findUserById(accountA.userId)).passwordHash, "replacement-test-hash");
  assert.deepEqual(await store.listSessions(accountA.userId), []);
  assert.equal(await store.resetPasswordWithToken(resetHash, "replayed-hash"), false);

  await store.upsertResource(principalA, { kind: "task", key: "shared-key", payload: { title: "tenant A" }, expectedVersion: 0 });
  await store.upsertResource(principalB, { kind: "task", key: "shared-key", payload: { title: "tenant B" }, expectedVersion: 0 });
  assert.equal((await store.listResources(principalA, "task"))[0].payload.title, "tenant A");
  assert.equal((await store.listResources(principalB, "task"))[0].payload.title, "tenant B");

  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('forge.tenant_id', $1, true), set_config('forge.user_id', $2, true)", [accountA.tenantId, accountA.userId]);
    const crossTenant = await client.query("SELECT resource_key FROM forge_tenant_resources WHERE tenant_id = $1", [accountB.tenantId]);
    assert.equal(crossTenant.rowCount, 0);
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }

  await assert.rejects(
    appPool.query("ALTER TABLE forge_tenant_resources DISABLE ROW LEVEL SECURITY"),
    /must be owner|permission denied/i,
  );
  console.log("PostgreSQL tenant isolation: ready");
} finally {
  await adminPool.query("DELETE FROM forge_tenants WHERE id = ANY($1::uuid[])", [[accountA.tenantId, accountB.tenantId]]).catch(() => undefined);
  await adminPool.query("DELETE FROM forge_users WHERE id = ANY($1::uuid[])", [[accountA.userId, accountB.userId]]).catch(() => undefined);
  await appPool.end();
  await adminPool.end();
}
