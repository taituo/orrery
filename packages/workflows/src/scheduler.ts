import type { InboundMessage } from "@orrery/core/pure";

/**
 * Pure scheduling logic of the bot entity workflow (unit-tested without a Temporal server).
 *
 * - one turn at a time per thread (ACP sessions are single-turn); different threads run
 *   concurrently up to `maxConcurrent`
 * - messages that arrive for a busy thread are coalesced into that thread's next turn
 * - FIFO by first arrival across threads
 */
export interface SchedulerState {
  queue: InboundMessage[];
  running: Record<string, string>;
  seen: string[];
  paused: boolean;
}

export const SEEN_WINDOW = 500;

export function enqueue(state: SchedulerState, msg: InboundMessage): boolean {
  if (state.seen.includes(msg.messageId)) return false; // idempotent signals
  state.seen.push(msg.messageId);
  if (state.seen.length > SEEN_WINDOW) state.seen.splice(0, state.seen.length - SEEN_WINDOW);
  state.queue.push(msg);
  return true;
}

export interface Batch {
  threadId: string;
  messages: InboundMessage[];
}

/** Take the next runnable batches (removing them from the queue). */
export function takeRunnable(state: SchedulerState, maxConcurrent: number): Batch[] {
  if (state.paused) return [];
  const out: Batch[] = [];
  let slots = maxConcurrent - Object.keys(state.running).length;
  if (slots <= 0) return out;
  const order: string[] = [];
  for (const m of state.queue) if (!order.includes(m.threadId)) order.push(m.threadId);
  for (const threadId of order) {
    if (slots <= 0) break;
    if (state.running[threadId]) continue;
    const messages = state.queue.filter((m) => m.threadId === threadId);
    state.queue = state.queue.filter((m) => m.threadId !== threadId);
    out.push({ threadId, messages });
    slots--;
  }
  return out;
}

export function hasRunnable(state: SchedulerState, maxConcurrent: number): boolean {
  if (state.paused) return false;
  if (Object.keys(state.running).length >= maxConcurrent) return false;
  return state.queue.some((m) => !state.running[m.threadId]);
}

/** Deterministic run id inside workflow code (time from the workflow clock + uuid4 entropy). */
export function makeRunId(nowMs: number, uuid: string): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let t = "";
  let v = nowMs;
  for (let i = 0; i < 10; i++) {
    const mod = v % 32;
    t = alphabet[mod] + t;
    v = (v - mod) / 32;
  }
  const hex = uuid.replace(/-/g, "");
  let r = "";
  for (let i = 0; i < 16; i++) r += alphabet[parseInt(hex.slice(i * 2, i * 2 + 2), 16) % 32];
  return `run_${t}${r}`;
}
