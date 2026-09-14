CREATE TABLE IF NOT EXISTS forge_encrypted_task_backups (
  tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  encrypted_payload MEDIUMTEXT CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  size_bytes INT UNSIGNED NOT NULL,
  task_count SMALLINT UNSIGNED NOT NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  backup_created_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (tenant_id, user_id),
  CONSTRAINT forge_encrypted_task_backups_size CHECK (size_bytes <= 8388608),
  CONSTRAINT forge_encrypted_task_backups_tasks CHECK (task_count <= 2000),
  CONSTRAINT forge_encrypted_task_backups_version CHECK (version > 0),
  CONSTRAINT forge_encrypted_task_backups_membership_fk FOREIGN KEY (tenant_id, user_id)
    REFERENCES forge_tenant_memberships(tenant_id, user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
