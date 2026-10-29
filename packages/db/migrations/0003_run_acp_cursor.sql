-- Resume point of an ACP turn (gateway session, last relayed seq, agent epoch, prompt sent),
-- written atomically with the run events it covers. Temporal heartbeats carry the same data but
-- are throttled by the SDK; this cursor lets a retried attempt resume exactly where the
-- persisted event stream ends.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS acp_cursor jsonb;
