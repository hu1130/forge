CREATE TABLE IF NOT EXISTS forge_users (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  email VARCHAR(320) NOT NULL,
  display_name VARCHAR(200) NOT NULL,
  password_hash VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  email_verified_at DATETIME(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  disabled_at DATETIME(3),
  CONSTRAINT forge_users_email_normalized CHECK (email = LOWER(email)),
  UNIQUE KEY forge_users_email_unique (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS forge_tenants (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  slug VARCHAR(200) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  kind ENUM('personal', 'team') NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY forge_tenants_slug_unique (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS forge_tenant_memberships (
  tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  role ENUM('owner', 'admin', 'member') NOT NULL,
  status ENUM('active', 'suspended') NOT NULL DEFAULT 'active',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (tenant_id, user_id),
  KEY forge_tenant_memberships_user (user_id, status),
  CONSTRAINT forge_membership_tenant_fk FOREIGN KEY (tenant_id) REFERENCES forge_tenants(id) ON DELETE CASCADE,
  CONSTRAINT forge_membership_user_fk FOREIGN KEY (user_id) REFERENCES forge_users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS forge_sessions (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  csrf_token VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3),
  UNIQUE KEY forge_sessions_token_hash_unique (token_hash),
  KEY forge_sessions_active_user (user_id, revoked_at, expires_at),
  KEY forge_sessions_user_created (user_id, created_at DESC),
  CONSTRAINT forge_sessions_membership_fk FOREIGN KEY (tenant_id, user_id)
    REFERENCES forge_tenant_memberships(tenant_id, user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
