CREATE TABLE IF NOT EXISTS forge_auth_action_tokens (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  purpose ENUM('verify_email', 'reset_password') NOT NULL,
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  consumed_at DATETIME(3),
  UNIQUE KEY forge_auth_action_tokens_hash_unique (token_hash),
  KEY forge_auth_action_tokens_active (user_id, purpose, consumed_at, expires_at),
  CONSTRAINT forge_auth_action_tokens_user_fk FOREIGN KEY (user_id) REFERENCES forge_users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
