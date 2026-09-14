CREATE TABLE IF NOT EXISTS forge_tenant_invitations (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  email VARCHAR(320) NOT NULL,
  role ENUM('admin', 'member') NOT NULL,
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  invited_by_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  accepted_at DATETIME(3),
  revoked_at DATETIME(3),
  UNIQUE KEY forge_tenant_invitations_token_unique (token_hash),
  KEY forge_tenant_invitations_tenant_pending (tenant_id, accepted_at, revoked_at, expires_at),
  KEY forge_tenant_invitations_email_pending (email, accepted_at, revoked_at, expires_at),
  CONSTRAINT forge_tenant_invitations_tenant_fk FOREIGN KEY (tenant_id) REFERENCES forge_tenants(id) ON DELETE CASCADE,
  CONSTRAINT forge_tenant_invitations_inviter_fk FOREIGN KEY (invited_by_user_id) REFERENCES forge_users(id) ON DELETE CASCADE,
  CONSTRAINT forge_tenant_invitations_email_normalized CHECK (email = LOWER(email))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
