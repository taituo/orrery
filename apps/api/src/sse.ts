import { EVENTS_CHANNEL, events, type Db, type PgListener } from "@orrery/db";
import type { RunEventEnvelope } from "@orrery/core";

/**
 * Live fan-out of run events to SSE clients.
 *
 * Workers append events to Postgres and NOTIFY `orrery_run_events` with {runId, threadId, seq}.
 * One LISTEN connection per API replica receives them; for each thread with subscribers, one
 * query fetches the new rows and broadcasts them to every subscriber of that thread. Clients
 * resume with `Last-Event-ID` (or `?since=`) and dedupe by `runId:seq`.
 */
type Subscriber = { send(e: RunEventEnvelope): void; teamId: string };
type TeamSubscriber = { send(n: { kind: string; [k: string]: unknown }): void };

export class EventHub {
  private readonly threads = new Map<string, Set<Subscriber>>();
  private readonly teams = new Map<string, Set<TeamSubscriber>>();
  private readonly cursors = new Map<string, number>(); // runId → last broadcast seq
  private readonly pending = new Map<string, Promise<void>>(); // runId → in-flight fetch
  private unsub: Array<() => void> = [];

  constructor(private readonly db: Db, private readonly listener: PgListener) {}

  async start(): Promise<void> {
    this.unsub.push(
      await this.listener.subscribe(EVENTS_CHANNEL, (payload) => {
        let n: { runId: string; threadId: string; teamId: string; seq: number };
        try {
          n = JSON.parse(payload);
        } catch {
          return;
        }
        for (const t of this.teams.get(n.teamId) ?? []) t.send({ kind: "run_event", runId: n.runId, threadId: n.threadId, seq: n.seq });
        if (this.threads.has(n.threadId)) void this.pump(n.runId, n.threadId);
      }),
    );
    this.unsub.push(
      await this.listener.subscribe("orrery_approvals", (id) => {
        for (const set of this.teams.values()) for (const t of set) t.send({ kind: "approval", id });
      }),
    );
  }

  stop(): void {
    for (const u of this.unsub) u();
  }

  private pump(runId: string, threadId: string): Promise<void> {
    // Serialize fetches per run; a notification during a fetch is folded into the next one.
    const prev = this.pending.get(runId) ?? Promise.resolve();
    const next = prev.then(async () => {
      const subs = this.threads.get(threadId);
      if (!subs?.size) return;
      let after = this.cursors.get(runId);
      if (after === undefined) {
        // first time we see this run on this replica: start from what clients already have
        after = 0;
      }
      const rows = await events.listForRun(this.db, runId, after, 2000);
      if (!rows.length) return;
      this.cursors.set(runId, rows[rows.length - 1]!.seq);
      if (this.cursors.size > 50_000) this.cursors.clear();
      for (const r of rows) for (const s of subs) s.send(r);
    });
    const guarded = next.catch(() => undefined);
    this.pending.set(runId, guarded);
    void guarded.finally(() => {
      if (this.pending.get(runId) === guarded) this.pending.delete(runId);
    });
    return guarded;
  }

  subscribeThread(threadId: string, sub: Subscriber): () => void {
    let set = this.threads.get(threadId);
    if (!set) this.threads.set(threadId, (set = new Set()));
    set.add(sub);
    return () => {
      set!.delete(sub);
      if (!set!.size) this.threads.delete(threadId);
    };
  }

  subscribeTeam(teamId: string, sub: TeamSubscriber): () => void {
    let set = this.teams.get(teamId);
    if (!set) this.teams.set(teamId, (set = new Set()));
    set.add(sub);
    return () => {
      set!.delete(sub);
      if (!set!.size) this.teams.delete(teamId);
    };
  }

  /**
   * Backlog for a thread after a cursor. The cursor is an SSE event id (`<ts>|<runId>:<seq>`):
   * when that event still exists, resumption is exact on (ts, run_id, seq) using the stored
   * microsecond timestamp; otherwise it falls back to the millisecond timestamp (inclusive —
   * clients dedupe by runId:seq). A bare ISO timestamp is accepted too.
   */
  async backlog(threadId: string, cursor: string | null, limit = 5000): Promise<RunEventEnvelope[]> {
    const toEnvelope = (x: Record<string, any>): RunEventEnvelope => ({ id: `${x.run_id}:${x.seq}`, runId: x.run_id, threadId: x.thread_id, botId: x.bot_id, seq: x.seq, ts: new Date(x.ts).toISOString(), event: x.event });
    if (!cursor) {
      const r = await this.db.query("SELECT * FROM run_events WHERE thread_id = $1 ORDER BY ts, run_id, seq LIMIT $2", [threadId, limit]);
      return r.rows.map(toEnvelope);
    }
    const [tsPart, key] = cursor.includes("|") ? (cursor.split("|", 2) as [string, string]) : [cursor, ""];
    const m = /^(.+):(\d+)$/.exec(key);
    if (m) {
      const r = await this.db.query(
        `WITH c AS (SELECT ts, run_id, seq FROM run_events WHERE run_id = $2 AND seq = $3 AND thread_id = $1)
         SELECT e.* FROM run_events e, c WHERE e.thread_id = $1 AND (e.ts, e.run_id, e.seq) > (c.ts, c.run_id, c.seq)
         ORDER BY e.ts, e.run_id, e.seq LIMIT $4`,
        [threadId, m[1], Number(m[2]), limit],
      );
      const exists = await this.db.query("SELECT 1 FROM run_events WHERE run_id = $1 AND seq = $2 AND thread_id = $3", [m[1], Number(m[2]), threadId]);
      if (exists.rowCount) return r.rows.map(toEnvelope);
    }
    const since = new Date(tsPart);
    if (Number.isNaN(since.getTime())) return [];
    const r = await this.db.query("SELECT * FROM run_events WHERE thread_id = $1 AND ts >= $2 ORDER BY ts, run_id, seq LIMIT $3", [threadId, since.toISOString(), limit]);
    return r.rows.map(toEnvelope);
  }
}
