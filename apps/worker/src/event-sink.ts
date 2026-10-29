import { events, runs, type Db } from "@orrery/db";
import type { AgentEvent } from "@orrery/core";
import type { TurnTracer } from "@orrery/observability";

/**
 * Buffered, ordered writer for a run's event stream.
 *
 * Agents stream many tiny chunks; persisting each one would hammer Postgres and the SSE fan-out.
 * Consecutive text deltas for the same message are coalesced and flushed every `flushMs`, while
 * state-changing events (tool calls, approvals, completion) flush immediately so the UI and
 * other processes see them without delay. Sequence numbers are assigned here, continuing from
 * the stored maximum so an activity retry appends instead of overwriting.
 */
export class RunEventSink {
  private buffer: AgentEvent[] = [];
  private seq: number;
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(
    private readonly db: Db,
    private readonly ref: { runId: string; teamId: string; botId: string; threadId: string },
    startSeq: number,
    private readonly tracer: TurnTracer | null,
    private readonly flushMs: number,
    private readonly cursor: (() => unknown) | null,
  ) {
    this.seq = startSeq;
  }

  /**
   * @param cursor optional snapshot persisted atomically with each flushed batch (the ACP
   *   resume point that the flushed events cover).
   */
  static async open(db: Db, ref: { runId: string; teamId: string; botId: string; threadId: string }, tracer: TurnTracer | null = null, flushMs = 60, cursor: (() => unknown) | null = null): Promise<RunEventSink> {
    const next = await events.nextSeq(db, ref.runId);
    return new RunEventSink(db, ref, next - 1, tracer, flushMs, cursor);
  }

  get lastSeq(): number {
    return this.seq;
  }

  push(e: AgentEvent): void {
    if (this.closed) return;
    this.tracer?.on(e);
    if (e.type === "approval.requested") void runs.setStatus(this.db, this.ref.runId, "waiting_approval").catch(() => undefined);
    if (e.type === "approval.resolved") void runs.setStatus(this.db, this.ref.runId, "running").catch(() => undefined);
    const last = this.buffer[this.buffer.length - 1];
    if (last && canMerge(last, e)) {
      this.buffer[this.buffer.length - 1] = merge(last, e);
    } else {
      this.buffer.push(e);
    }
    if (isUrgent(e) || this.buffer.length >= 200) void this.flush();
    else if (!this.timer) this.timer = setTimeout(() => void this.flush(), this.flushMs);
  }

  /** Push and wait until persisted (used where ordering with other writes matters). */
  async pushNow(e: AgentEvent): Promise<void> {
    this.push(e);
    await this.flush();
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch = this.buffer;
    this.buffer = [];
    if (!batch.length) return this.flushing;
    const rows = batch.map((event) => ({ ...this.ref, seq: ++this.seq, event }));
    // Snapshot now: the cursor covers exactly the events cut into this batch.
    const cursor = this.cursor ? structuredClone(this.cursor()) : undefined;
    this.flushing = this.flushing.then(() => events.append(this.db, rows, cursor)).catch(async () => {
      // one retry, then give up on this batch rather than blocking the turn
      await events.append(this.db, rows, cursor).catch(() => undefined);
    });
    return this.flushing;
  }

  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
  }
}

function isUrgent(e: AgentEvent): boolean {
  return !(e.type === "message.delta" || e.type === "thought.delta" || e.type === "usage" || e.type === "tool.update");
}

function canMerge(a: AgentEvent, b: AgentEvent): boolean {
  if (a.type === "message.delta" && b.type === "message.delta") return a.messageId === b.messageId && a.part.type === "text" && b.part.type === "text";
  if (a.type === "thought.delta" && b.type === "thought.delta") return a.messageId === b.messageId && a.part.type === "text" && b.part.type === "text";
  if (a.type === "tool.update" && b.type === "tool.update") return a.toolCallId === b.toolCallId && !b.patch.status;
  return false;
}

function merge(a: AgentEvent, b: AgentEvent): AgentEvent {
  if ((a.type === "message.delta" || a.type === "thought.delta") && (b.type === "message.delta" || b.type === "thought.delta") && a.part.type === "text" && b.part.type === "text") {
    return { ...a, part: { type: "text", text: a.part.text + b.part.text } };
  }
  if (a.type === "tool.update" && b.type === "tool.update") return { ...a, patch: { ...a.patch, ...stripNull(b.patch) } };
  return b;
}

function stripNull<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as Partial<T>;
}
