import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createForgeMySqlPool, migrateDatabase, MySqlAuthStore } from "../apps/cloud-api/dist/mysql-store.js";
import { TeamAccessError, TeamConflictError } from "../apps/cloud-api/dist/team-service.js";

const appUrl = process.env.FORGE_TEST_MYSQL_URL || "mysql://forge_app:forge_app_dev_only@127.0.0.1:33069/forge";
const migrationUrl = process.env.FORGE_TEST_MYSQL_MIGRATION_URL || "mysql://forge_migrator:forge_dev_only@127.0.0.1:33069/forge";
const adminPool = createForgeMySqlPool(migrationUrl, 1);
const appPool = createForgeMySqlPool(appUrl, 2);
const store = new MySqlAuthStore(appPool);

const accountA = { userId: randomUUID(), tenantId: randomUUID(), email: `mysql-a-${randomUUID()}@example.test` };
const accountB = { userId: randomUUID(), tenantId: randomUUID(), email: `mysql-b-${randomUUID()}@example.test` };
const secondaryTenantId = randomUUID();

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
  const [appliedMigrations] = await adminPool.query("SELECT name FROM forge_schema_migrations ORDER BY name");
  assert.deepEqual(appliedMigrations.map((row) => row.name), ["001_identity.sql", "002_tenant_resources.sql", "003_account_security.sql", "004_team_workspaces.sql"]);
  await createAccount(accountA, "MYSQLA", new Date().toISOString());
  await createAccount(accountB, "MYSQLB");
  await adminPool.execute(
    "INSERT INTO forge_tenants (id, name, slug, kind) VALUES (?, 'MYSQLA Team', ?, 'team')",
    [secondaryTenantId, `mysql-a-team-${secondaryTenantId.slice(0, 8)}`],
  );
  await adminPool.execute(
    "INSERT INTO forge_tenant_memberships (tenant_id, user_id, role) VALUES (?, ?, 'owner')",
    [secondaryTenantId, accountA.userId],
  );
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
  const secondaryTenantSessionId = randomUUID();
  const sessionInput = (id, userId, tenantId, tokenHash) => ({
    id, userId, tenantId, tokenHash, csrfToken: randomUUID(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await store.createSession(sessionInput(firstSessionId, accountA.userId, accountA.tenantId, "b".repeat(64)));
  await store.createSession(sessionInput(secondSessionId, accountA.userId, accountA.tenantId, "c".repeat(64)));
  await store.createSession(sessionInput(foreignSessionId, accountB.userId, accountB.tenantId, "d".repeat(64)));
  await store.createSession(sessionInput(secondaryTenantSessionId, accountA.userId, secondaryTenantId, "f".repeat(64)));
  assert.deepEqual(new Set((await store.listSessions(accountA.userId, accountA.tenantId)).map((session) => session.id)), new Set([firstSessionId, secondSessionId]));
  assert.equal(await store.revokeUserSession(accountA.userId, accountA.tenantId, secondaryTenantSessionId), false);
  assert.equal(await store.revokeUserSession(accountA.userId, accountA.tenantId, foreignSessionId), false);
  assert.equal(await store.revokeOtherSessions(accountA.userId, accountA.tenantId, firstSessionId), 1);
  assert.deepEqual((await store.listSessions(accountA.userId, accountA.tenantId)).map((session) => session.id), [firstSessionId]);
  assert.ok(await store.findSession("f".repeat(64)));

  const invitationId = randomUUID();
  await store.createInvitation({
    id: invitationId,
    tokenHash: "0".repeat(64),
    tenantId: secondaryTenantId,
    actorUserId: accountA.userId,
    email: accountB.email,
    role: "member",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal((await store.listPendingInvitations(accountB.userId, accountB.email)).length, 1);
  const acceptedTenant = await store.acceptInvitation({ invitationId, userId: accountB.userId, email: accountB.email });
  assert.equal(acceptedTenant.id, secondaryTenantId);
  assert.equal(acceptedTenant.role, "member");
  assert.equal((await store.listPendingInvitations(accountB.userId, accountB.email)).length, 0);
  assert.equal((await store.listTenants(accountB.userId)).some((tenant) => tenant.id === secondaryTenantId && tenant.role === "member"), true);
  await assert.rejects(
    store.createInvitation({
      id: randomUUID(), tokenHash: "1".repeat(64), tenantId: secondaryTenantId,
      actorUserId: accountB.userId, email: `third-${randomUUID()}@example.test`, role: "member",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    (error) => error instanceof TeamAccessError,
  );
  await assert.rejects(
    store.updateMemberRole({ tenantId: secondaryTenantId, userId: accountA.userId }, accountA.userId, "admin"),
    (error) => error instanceof TeamConflictError,
  );
  assert.equal(await store.updateMemberRole({ tenantId: secondaryTenantId, userId: accountA.userId }, accountB.userId, "admin"), true);
  const memberSessionId = randomUUID();
  await store.createSession(sessionInput(memberSessionId, accountB.userId, secondaryTenantId, "2".repeat(64)));
  assert.equal(await store.removeMember({ tenantId: secondaryTenantId, userId: accountA.userId }, accountB.userId), true);
  assert.equal(await store.findSession("2".repeat(64)), undefined);

  const resetHash = "e".repeat(64);
  await store.createActionToken({
    id: randomUUID(), userId: accountA.userId, purpose: "reset_password",
    tokenHash: resetHash, expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(await store.resetPasswordWithToken(resetHash, "replacement-test-hash"), true);
  assert.equal((await store.findUserById(accountA.userId)).passwordHash, "replacement-test-hash");
  assert.deepEqual(await store.listSessions(accountA.userId, accountA.tenantId), []);
  assert.equal(await store.findSession("f".repeat(64)), undefined);
  assert.equal(await store.resetPasswordWithToken(resetHash, "replayed-hash"), false);

  await store.upsertResource(principalA, { kind: "task", key: "shared-key", payload: { title: "tenant A" }, expectedVersion: 0 });
  await store.upsertResource(principalB, { kind: "task", key: "shared-key", payload: { title: "tenant B" }, expectedVersion: 0 });
  assert.equal((await store.listResources(principalA, "task"))[0].payload.title, "tenant A");
  assert.equal((await store.listResources(principalB, "task"))[0].payload.title, "tenant B");
  await assert.rejects(
    store.listResources({ tenantId: accountB.tenantId, userId: accountA.userId }, "task"),
    /无权访问该租户/,
  );

  await adminPool.execute(
    "UPDATE forge_tenant_memberships SET status = 'suspended' WHERE tenant_id = ? AND user_id = ?",
    [accountB.tenantId, accountB.userId],
  );
  assert.equal(await store.findSession("d".repeat(64)), undefined);
  await assert.rejects(store.listResources(principalB, "task"), /无权访问该租户/);

  await assert.rejects(
    appPool.query("ALTER TABLE forge_tenant_resources ADD COLUMN forbidden_change INT NULL"),
    /ALTER command denied|access denied/i,
  );
  console.log("MySQL tenant isolation: ready");
} finally {
  await adminPool.execute("DELETE FROM forge_tenants WHERE id IN (?, ?, ?)", [accountA.tenantId, accountB.tenantId, secondaryTenantId]).catch(() => undefined);
  await adminPool.execute("DELETE FROM forge_users WHERE id IN (?, ?)", [accountA.userId, accountB.userId]).catch(() => undefined);
  await appPool.end();
  await adminPool.end();
}
