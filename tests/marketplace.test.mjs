import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("marketplace catalog has unique installable Skills and MCP entries", async () => {
  const catalog = JSON.parse(await readFile("apps/daemon/resources/marketplace.json", "utf8"));
  assert.equal(catalog.schemaVersion, 1);
  assert.ok(catalog.items.length >= 4);
  assert.equal(new Set(catalog.items.map((item) => item.id)).size, catalog.items.length);
  assert.ok(catalog.items.some((item) => item.kind === "skill"));
  assert.ok(catalog.items.some((item) => item.kind === "mcp"));
  for (const item of catalog.items) {
    assert.ok(item.name && item.description && item.details && item.version && item.publisher);
    if (item.kind === "skill" && item.source.kind === "bundled") {
      await access(path.join("apps/daemon/resources", item.source.path, "SKILL.md"));
    }
  }
});

test("marketplace exposes discovery, refresh, install, update, and uninstall paths", async () => {
  const server = await readFile("apps/daemon/src/server.ts", "utf8");
  const store = await readFile("apps/daemon/src/marketplace.ts", "utf8");
  const panel = await readFile("apps/web/src/MarketplacePanel.tsx", "utf8");
  for (const route of ["/api/marketplace", "/api/marketplace/refresh", "/api/marketplace/items/:id/install", "/api/marketplace/items/:id"]) {
    assert.ok(server.includes(route), `Missing marketplace API: ${route}`);
  }
  assert.match(store, /createHash\("sha256"\)/);
  assert.match(store, /allowedDownloadHosts/);
  assert.match(store, /Skill 压缩包包含越界路径/);
  assert.match(panel, /搜索名称、功能或发布者/);
  assert.match(panel, /updateAvailable/);
  assert.match(panel, /确定卸载/);
});
