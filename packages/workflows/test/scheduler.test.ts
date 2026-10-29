import { describe, expect, it } from "vitest";
import type { InboundMessage } from "@orrery/core";
import { enqueue, hasRunnable, makeRunId, takeRunnable, type SchedulerState } from "../src/scheduler.js";

const msg = (id: string, threadId: string): InboundMessage => ({
  messageId: id,
  threadId,
  botId: "bot_1",
  teamId: "team_1",
  channel: "web",
  author: { type: "user", id: "usr_1" },
  parts: [{ type: "text", text: id }],
  replyTo: null,
  receivedAt: new Date(0).toISOString(),
});

const fresh = (): SchedulerState => ({ queue: [], running: {}, seen: [], paused: false });

describe("bot scheduler", () => {
  it("dedupes signals by message id", () => {
    const s = fresh();
    expect(enqueue(s, msg("m1", "t1"))).toBe(true);
    expect(enqueue(s, msg("m1", "t1"))).toBe(false);
    expect(s.queue).toHaveLength(1);
  });

  it("runs one turn per thread and coalesces messages that arrive while busy", () => {
    const s = fresh();
    enqueue(s, msg("m1", "t1"));
    let b = takeRunnable(s, 4);
    expect(b).toEqual([{ threadId: "t1", messages: [expect.objectContaining({ messageId: "m1" })] }]);
    s.running.t1 = "run_a";
    enqueue(s, msg("m2", "t1"));
    enqueue(s, msg("m3", "t1"));
    expect(hasRunnable(s, 4)).toBe(false);
    expect(takeRunnable(s, 4)).toEqual([]);
    delete s.running.t1;
    b = takeRunnable(s, 4);
    expect(b[0]!.messages.map((m) => m.messageId)).toEqual(["m2", "m3"]);
  });

  it("runs different threads concurrently up to the limit, FIFO by first arrival", () => {
    const s = fresh();
    for (const [id, t] of [["a", "t1"], ["b", "t2"], ["c", "t3"], ["d", "t1"]] as const) enqueue(s, msg(id, t));
    const b = takeRunnable(s, 2);
    expect(b.map((x) => x.threadId)).toEqual(["t1", "t2"]);
    expect(b[0]!.messages.map((m) => m.messageId)).toEqual(["a", "d"]);
    expect(s.queue.map((m) => m.messageId)).toEqual(["c"]);
  });

  it("does nothing while paused", () => {
    const s = fresh();
    s.paused = true;
    enqueue(s, msg("m1", "t1"));
    expect(hasRunnable(s, 4)).toBe(false);
    expect(takeRunnable(s, 4)).toEqual([]);
  });

  it("makes deterministic, sortable run ids", () => {
    const a = makeRunId(1_700_000_000_000, "123e4567-e89b-12d3-a456-426614174000");
    const b = makeRunId(1_700_000_000_000, "123e4567-e89b-12d3-a456-426614174000");
    const c = makeRunId(1_700_000_000_001, "00000000-0000-0000-0000-000000000000");
    expect(a).toBe(b);
    expect(a).toMatch(/^run_[0-9A-Z]{26}$/);
    expect(c > a).toBe(true);
  });
});
