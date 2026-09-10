CREATE TABLE IF NOT EXISTS forge_users (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  CONSTRAINT forge_users_email_normalized CHECK (email = lower(email))
);
CREATE UNIQUE INDEX IF NOT EXISTS forge_users_email_unique ON forge_users (email);

CREATE TABLE IF NOT EXISTS forge_tenants (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('personal', 'team')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS forge_tenant_memberships (
  tenant_id uuid NOT NULL REFERENCES forge_tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES forge_users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX IF NOT EXISTS forge_tenant_memberships_user ON forge_tenant_memberships (user_id, status);

CREATE TABLE IF NOT EXISTS forge_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  token_hash char(64) NOT NULL UNIQUE,
  csrf_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY (tenant_id, user_id) REFERENCES forge_tenant_memberships(tenant_id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS forge_sessions_active_user ON forge_sessions (user_id, expires_at) WHERE revoked_at IS NULL;
