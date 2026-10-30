-- API tokens: bearer tokens for the CLI, MCP clients and scripts. Only a SHA-256 of the token is
-- stored; the token itself is shown once, at creation.
CREATE TABLE IF NOT EXISTS api_tokens (
  id            text PRIMARY KEY,
  team_id       text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id       text NOT NULL,
  user_name     text,
  name          text NOT NULL,
  role          text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  token_hash    text NOT NULL UNIQUE,
  prefix        text NOT NULL,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  expires_at    timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX IF NOT EXISTS api_tokens_team ON api_tokens (team_id, created_at DESC);
