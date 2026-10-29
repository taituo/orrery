-- Orrery schema v1. `{{VECTOR_DIMS}}` is substituted by the migrator (ORRERY_VECTOR_DIMS,
-- default 1536). Embeddings from smaller models are zero-padded, which preserves cosine
-- similarity; queries always filter by embedding_model so vectors from different models are
-- never compared.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ------------------------------------------------------------------ tenancy
CREATE TABLE teams (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id           text PRIMARY KEY,
  team_id      text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  external_id  text,
  email        text,
  name         text,
  role         text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, external_id)
);

-- ------------------------------------------------------------------ bots
CREATE TABLE bots (
  id          text PRIMARY KEY,
  team_id     text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  spec        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bots_team ON bots (team_id, status);

-- ------------------------------------------------------------------ conversation
CREATE TABLE threads (
  id                text PRIMARY KEY,
  team_id           text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  bot_id            text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  title             text NOT NULL DEFAULT 'New conversation',
  channel           text NOT NULL DEFAULT 'web',
  acp_session_id    text,
  acp_agent_epoch   text,
  created_by        text NOT NULL,
  archived          boolean NOT NULL DEFAULT false,
  last_activity_at  timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX threads_bot_activity ON threads (bot_id, last_activity_at DESC);
CREATE INDEX threads_team_activity ON threads (team_id, last_activity_at DESC);

CREATE TABLE messages (
  id          text PRIMARY KEY,
  team_id     text NOT NULL,
  thread_id   text NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'peer')),
  author      jsonb NOT NULL,
  parts       jsonb NOT NULL,
  run_id      text,
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_thread ON messages (thread_id, created_at);

CREATE TABLE runs (
  id                  text PRIMARY KEY,
  team_id             text NOT NULL,
  bot_id              text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  thread_id           text NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  trigger_message_id  text,
  status              text NOT NULL CHECK (status IN ('queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled', 'interrupted')),
  provider            text NOT NULL,
  model               text,
  engine              text,
  stop_reason         text,
  usage               jsonb NOT NULL DEFAULT '{}'::jsonb,
  error               jsonb,
  workflow_id         text NOT NULL,
  trace_id            text,
  -- prepared prompt (memory/knowledge preamble + user parts), read by turn activities
  input               jsonb,
  started_at          timestamptz NOT NULL DEFAULT now(),
  ended_at            timestamptz
);
CREATE INDEX runs_thread ON runs (thread_id, started_at DESC);
CREATE INDEX runs_bot_status ON runs (bot_id, status);

-- Ordered, append-only event stream per run (what the UI renders and replays).
CREATE TABLE run_events (
  run_id     text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq        integer NOT NULL,
  team_id    text NOT NULL,
  bot_id     text NOT NULL,
  thread_id  text NOT NULL,
  type       text NOT NULL,
  event      jsonb NOT NULL,
  ts         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX run_events_thread ON run_events (thread_id, ts);

CREATE TABLE steering (
  id          bigserial PRIMARY KEY,
  run_id      text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  parts       jsonb NOT NULL,
  created_by  text NOT NULL,
  consumed    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX steering_pending ON steering (run_id) WHERE NOT consumed;

-- ------------------------------------------------------------------ approvals
CREATE TABLE approvals (
  id            text PRIMARY KEY,
  team_id       text NOT NULL,
  bot_id        text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  thread_id     text NOT NULL,
  run_id        text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  tool_call_id  text NOT NULL,
  title         text NOT NULL,
  kind          text NOT NULL,
  capability    text NOT NULL,
  resource      text NOT NULL,
  raw_input     jsonb,
  options       jsonb NOT NULL,
  consent       jsonb,
  mcp_tool      jsonb,
  risk          real,
  status        text NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'cancelled')),
  decision      jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);
CREATE INDEX approvals_team_pending ON approvals (team_id, created_at DESC) WHERE status = 'pending';
CREATE INDEX approvals_run ON approvals (run_id);

-- ------------------------------------------------------------------ memory
CREATE TABLE memories (
  id                text PRIMARY KEY,
  team_id           text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  bot_id            text REFERENCES bots(id) ON DELETE CASCADE,
  user_id           text,
  scope             text NOT NULL CHECK (scope IN ('bot', 'team', 'user')),
  kind              text NOT NULL,
  content           text NOT NULL,
  tags              text[] NOT NULL DEFAULT '{}',
  importance        real NOT NULL DEFAULT 0.5,
  confidence        real NOT NULL DEFAULT 0.8,
  pinned            boolean NOT NULL DEFAULT false,
  source            jsonb NOT NULL DEFAULT '{}'::jsonb,
  valid_from        timestamptz NOT NULL DEFAULT now(),
  valid_to          timestamptz,
  superseded_by     text,
  access_count      integer NOT NULL DEFAULT 0,
  last_accessed_at  timestamptz,
  embedding         vector({{VECTOR_DIMS}}),
  embedding_model   text,
  content_tsv       tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memories_scope ON memories (team_id, bot_id, kind) WHERE valid_to IS NULL;
CREATE INDEX memories_tsv ON memories USING gin (content_tsv);
CREATE INDEX memories_trgm ON memories USING gin (content gin_trgm_ops);
CREATE INDEX memories_embedding ON memories USING hnsw (embedding vector_cosine_ops) WHERE valid_to IS NULL;

-- Small, always-in-context blocks (persona / about the humans / scratch notes), Letta-style.
CREATE TABLE core_memory (
  bot_id      text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  block       text NOT NULL CHECK (block IN ('persona', 'human', 'notes')),
  content     text NOT NULL DEFAULT '',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bot_id, block)
);

-- One per completed turn: the raw material for consolidation and episodic recall.
CREATE TABLE episodes (
  id               text PRIMARY KEY,
  team_id          text NOT NULL,
  bot_id           text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  thread_id        text NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  run_id           text NOT NULL,
  user_text        text NOT NULL,
  assistant_text   text NOT NULL,
  summary          text,
  tools            jsonb NOT NULL DEFAULT '[]'::jsonb,
  processed        boolean NOT NULL DEFAULT false,
  embedding        vector({{VECTOR_DIMS}}),
  embedding_model  text,
  content_tsv      tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(summary, '') || ' ' || user_text || ' ' || assistant_text)) STORED,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX episodes_bot ON episodes (bot_id, created_at DESC);
CREATE INDEX episodes_unprocessed ON episodes (bot_id) WHERE NOT processed;
CREATE INDEX episodes_tsv ON episodes USING gin (content_tsv);
CREATE INDEX episodes_embedding ON episodes USING hnsw (embedding vector_cosine_ops);

-- ------------------------------------------------------------------ knowledge (RAG)
CREATE TABLE knowledge_bases (
  id               text PRIMARY KEY,
  team_id          text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name             text NOT NULL,
  description      text NOT NULL DEFAULT '',
  embedding_model  text NOT NULL,
  embedding_dims   integer NOT NULL,
  chunk_size       integer NOT NULL DEFAULT 1200,
  chunk_overlap    integer NOT NULL DEFAULT 150,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_sources (
  id                 text PRIMARY KEY,
  knowledge_base_id  text NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  type               text NOT NULL CHECK (type IN ('upload', 'url', 'text')),
  uri                text NOT NULL,
  title              text NOT NULL,
  mime_type          text,
  content            bytea,
  status             text NOT NULL CHECK (status IN ('pending', 'ingesting', 'ready', 'failed')),
  error              text,
  stats              jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_hash       text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_sources_kb ON knowledge_sources (knowledge_base_id);

CREATE TABLE chunks (
  id                 text PRIMARY KEY,
  knowledge_base_id  text NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  source_id          text NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  ord                integer NOT NULL,
  content            text NOT NULL,
  heading            text,
  meta               jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding          vector({{VECTOR_DIMS}}),
  embedding_model    text,
  content_tsv        tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(heading, '') || ' ' || content)) STORED,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chunks_source ON chunks (source_id, ord);
CREATE INDEX chunks_tsv ON chunks USING gin (content_tsv);
CREATE INDEX chunks_embedding ON chunks USING hnsw (embedding vector_cosine_ops);

-- ------------------------------------------------------------------ routines, delegation
CREATE TABLE routines (
  id            text PRIMARY KEY,
  team_id       text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  bot_id        text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  name          text NOT NULL,
  prompt        text NOT NULL,
  schedule      jsonb NOT NULL,
  thread_policy text NOT NULL DEFAULT 'reuse',
  thread_id     text,
  enabled       boolean NOT NULL DEFAULT true,
  last_run_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX routines_bot ON routines (bot_id);

CREATE TABLE delegations (
  id            text PRIMARY KEY,
  team_id       text NOT NULL,
  from_bot_id   text NOT NULL,
  from_thread_id text NOT NULL,
  from_run_id   text,
  to_bot_id     text NOT NULL,
  to_thread_id  text,
  request       text NOT NULL,
  status        text NOT NULL CHECK (status IN ('requested', 'running', 'completed', 'failed')),
  result        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);

-- ------------------------------------------------------------------ computers
CREATE TABLE computers (
  id              text PRIMARY KEY,
  team_id         text NOT NULL,
  bot_id          text,
  shared          boolean NOT NULL DEFAULT false,
  status          text NOT NULL CHECK (status IN ('provisioning', 'running', 'stopping', 'stopped', 'failed')),
  endpoint        text,
  agent_kind      text NOT NULL,
  image           text,
  spec_hash       text,
  last_active_at  timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX computers_bot ON computers (bot_id) WHERE bot_id IS NOT NULL AND NOT shared;

-- ------------------------------------------------------------------ governance
CREATE TABLE usage_records (
  run_id         text PRIMARY KEY,
  team_id        text NOT NULL,
  bot_id         text NOT NULL,
  provider       text NOT NULL,
  model          text,
  input_tokens   bigint,
  output_tokens  bigint,
  credits        numeric,
  cost_usd       numeric,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_team_time ON usage_records (team_id, created_at);

CREATE TABLE audit_log (
  id          text PRIMARY KEY,
  team_id     text NOT NULL,
  actor       text NOT NULL,
  action      text NOT NULL,
  target      text,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_team_time ON audit_log (team_id, created_at DESC);

-- Encrypted secrets referenced as secret://<name> (MCP headers, integration tokens).
CREATE TABLE secrets (
  team_id     text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name        text NOT NULL,
  ciphertext  bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, name)
);
