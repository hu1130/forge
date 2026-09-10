CREATE TABLE IF NOT EXISTS forge_tenant_resources (
  tenant_id uuid NOT NULL REFERENCES forge_tenants(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('project', 'task', 'skill', 'mcp')),
  resource_key text NOT NULL CHECK (resource_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  owner_user_id uuid NOT NULL,
  updated_by_user_id uuid NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, kind, resource_key),
  FOREIGN KEY (tenant_id, owner_user_id) REFERENCES forge_tenant_memberships(tenant_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, updated_by_user_id) REFERENCES forge_tenant_memberships(tenant_id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS forge_tenant_resources_updated
  ON forge_tenant_resources (tenant_id, updated_at DESC);

ALTER TABLE forge_tenant_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE forge_tenant_resources FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS forge_tenant_resources_isolation ON forge_tenant_resources;
CREATE POLICY forge_tenant_resources_isolation ON forge_tenant_resources
  USING (
    tenant_id = NULLIF(current_setting('forge.tenant_id', true), '')::uuid
    AND EXISTS (
      SELECT 1
        FROM forge_tenant_memberships membership
       WHERE membership.tenant_id = forge_tenant_resources.tenant_id
         AND membership.user_id = NULLIF(current_setting('forge.user_id', true), '')::uuid
         AND membership.status = 'active'
    )
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('forge.tenant_id', true), '')::uuid
    AND EXISTS (
      SELECT 1
        FROM forge_tenant_memberships membership
       WHERE membership.tenant_id = forge_tenant_resources.tenant_id
         AND membership.user_id = NULLIF(current_setting('forge.user_id', true), '')::uuid
         AND membership.status = 'active'
    )
  );
