-- Group conversations: several bots (and people) in one thread. Bots answer when mentioned
-- (@name); otherwise the lead bot answers. Bots hand work to each other by mentioning them.
CREATE TABLE IF NOT EXISTS rooms (
  id          text PRIMARY KEY,
  team_id     text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name        text NOT NULL,
  topic       text NOT NULL DEFAULT '',
  thread_id   text NOT NULL UNIQUE REFERENCES threads(id) ON DELETE CASCADE,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived    boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS rooms_team_name ON rooms (team_id, lower(name)) WHERE NOT archived;

CREATE TABLE IF NOT EXISTS room_members (
  room_id   text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  bot_id    text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  position  integer NOT NULL,
  lead      boolean NOT NULL DEFAULT false,
  PRIMARY KEY (room_id, bot_id)
);

-- Each bot keeps its own agent session per conversation (a group thread has several).
CREATE TABLE IF NOT EXISTS thread_sessions (
  thread_id        text NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  bot_id           text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  acp_session_id   text,
  acp_agent_epoch  text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, bot_id)
);
INSERT INTO thread_sessions (thread_id, bot_id, acp_session_id, acp_agent_epoch)
  SELECT id, bot_id, acp_session_id, acp_agent_epoch FROM threads WHERE acp_session_id IS NOT NULL
  ON CONFLICT DO NOTHING;

-- One delivery intent per (message, bot): a group message can go to several bots.
ALTER TABLE delivery_outbox DROP CONSTRAINT IF EXISTS delivery_outbox_pkey;
ALTER TABLE delivery_outbox ADD PRIMARY KEY (message_id, bot_id);
