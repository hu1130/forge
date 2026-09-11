CREATE TABLE IF NOT EXISTS forge_tenant_resources (
  tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  kind ENUM('project', 'task', 'skill', 'mcp') NOT NULL,
  resource_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  updated_by_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload JSON NOT NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (tenant_id, kind, resource_key),
  KEY forge_tenant_resources_updated (tenant_id, updated_at DESC),
  CONSTRAINT forge_tenant_resources_key_format CHECK (resource_key REGEXP '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT forge_tenant_resources_version_positive CHECK (version > 0),
  CONSTRAINT forge_tenant_resources_tenant_fk FOREIGN KEY (tenant_id) REFERENCES forge_tenants(id) ON DELETE CASCADE,
  CONSTRAINT forge_tenant_resources_owner_fk FOREIGN KEY (tenant_id, owner_user_id)
    REFERENCES forge_tenant_memberships(tenant_id, user_id) ON DELETE CASCADE,
  CONSTRAINT forge_tenant_resources_updater_fk FOREIGN KEY (tenant_id, updated_by_user_id)
    REFERENCES forge_tenant_memberships(tenant_id, user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
