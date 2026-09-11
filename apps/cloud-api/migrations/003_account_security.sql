ALTER TABLE forge_users
  ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

CREATE TABLE IF NOT EXISTS forge_auth_action_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES forge_users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  token_hash char(64) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE INDEX IF NOT EXISTS forge_auth_action_tokens_active
  ON forge_auth_action_tokens (user_id, purpose, expires_at)
  WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS forge_sessions_user_created
  ON forge_sessions (user_id, created_at DESC);
