-- Transactional outbox for inbound messages: a message is stored together with its delivery
-- intent, so a turn is never lost when the workflow engine is briefly unreachable. Delivery
-- is idempotent (the bot workflow de-duplicates by message id), so retries are safe.
CREATE TABLE IF NOT EXISTS delivery_outbox (
  message_id       text PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  team_id          text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  bot_id           text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  inbound          jsonb NOT NULL,
  attempts         integer NOT NULL DEFAULT 0,
  last_error       text,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS delivery_outbox_due ON delivery_outbox (next_attempt_at);
