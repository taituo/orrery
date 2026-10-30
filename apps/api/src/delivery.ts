import { withTx, messages, outbox, threads, type Db } from "@orrery/db";
import type { InboundMessage, Message } from "@orrery/core";
import type { Logger } from "pino";
import type { WorkflowGateway } from "./workflow-gateway.js";

/**
 * Reliable inbound delivery (transactional outbox).
 *
 * The message row and its delivery intent are written in one transaction; delivery to the bot
 * workflow (signalWithStart) is then attempted right away. If the workflow engine is briefly
 * unreachable the request still succeeds — the outbox relay retries with backoff until the
 * signal lands. The bot workflow de-duplicates by message id, so retries never double a turn.
 */
export class Delivery {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly db: Db, private readonly workflows: WorkflowGateway, private readonly log: Logger, private readonly opts: { attemptTimeoutMs?: number; pollMs?: number } = {}) {}

  /** Persist the message + intent, then try to deliver now. */
  async submit(msg: Omit<Message, "id" | "createdAt"> & { teamId: string }, inbound: Omit<InboundMessage, "messageId" | "receivedAt">): Promise<{ message: Message; delivered: boolean }> {
    const { message, full } = await withTx(this.db, async (tx) => {
      const message = await messages.insert(tx, msg);
      const full: InboundMessage = { ...inbound, messageId: message.id, receivedAt: message.createdAt };
      await outbox.add(tx, full);
      await threads.touch(tx, msg.threadId);
      return { message, full };
    });
    const delivered = await this.attempt(full, 0);
    return { message, delivered };
  }

  /**
   * One message for several bots (a group conversation): stored once, one delivery intent per
   * bot, all in one transaction; then delivered to each bot's workflow.
   */
  async submitFanout(
    msg: Omit<Message, "id" | "createdAt"> & { teamId: string },
    inbound: Omit<InboundMessage, "messageId" | "receivedAt" | "botId">,
    botIds: string[],
  ): Promise<{ message: Message; delivered: boolean }> {
    const { message, all } = await withTx(this.db, async (tx) => {
      const message = await messages.insert(tx, msg);
      const all: InboundMessage[] = botIds.map((botId) => ({ ...inbound, botId, messageId: message.id, receivedAt: message.createdAt }));
      for (const i of all) await outbox.add(tx, i);
      await threads.touch(tx, msg.threadId);
      return { message, all };
    });
    const results = await Promise.all(all.map((i) => this.attempt(i, 0)));
    return { message, delivered: results.every(Boolean) };
  }

  private async attempt(inbound: InboundMessage, attempts: number): Promise<boolean> {
    try {
      await withTimeout(this.workflows.deliver(inbound), this.opts.attemptTimeoutMs ?? 4_000);
      await outbox.done(this.db, inbound.messageId, inbound.botId);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await outbox.failed(this.db, inbound.messageId, inbound.botId, message, attempts).catch(() => undefined);
      this.log.warn({ messageId: inbound.messageId, attempts: attempts + 1, err: message }, "delivery deferred to outbox");
      return false;
    }
  }

  /** Relay loop: safe to run in every API replica (rows are leased with SKIP LOCKED). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.pollMs ?? 5_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let delivered = 0;
    try {
      for (const e of await outbox.claim(this.db)) if (await this.attempt(e.inbound, e.attempts)) delivered++;
    } catch (err) {
      this.log.warn({ err: String(err) }, "outbox relay tick failed");
    } finally {
      this.running = false;
    }
    return delivered;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e: unknown) => (clearTimeout(t), reject(e)),
    );
  });
}
