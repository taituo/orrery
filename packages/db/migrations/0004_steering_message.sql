-- Steering entries point at the user message that carries them, so guidance an agent cannot take
-- mid-turn (no steering support, or the turn ended first) is re-queued as that same message
-- instead of being lost.
ALTER TABLE steering ADD COLUMN IF NOT EXISTS message_id text REFERENCES messages(id) ON DELETE SET NULL;
