import pg from "pg";

/**
 * Durable LISTEN connection with automatic reconnect. Used by the API (SSE fan-out of run
 * events, approval decisions) and by ACP turn activities (steering, approvals).
 */
export class PgListener {
  private client: pg.Client | null = null;
  private readonly handlers = new Map<string, Set<(payload: string) => void>>();
  private closed = false;
  private reconnecting = false;

  constructor(private readonly connectionString: string, private readonly onError?: (err: unknown) => void) {}

  async start(): Promise<void> {
    await this.connect();
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({ connectionString: this.connectionString, application_name: "orrery-listener" });
    client.on("notification", (n) => {
      const set = this.handlers.get(n.channel);
      if (!set) return;
      for (const h of set) {
        try {
          h(n.payload ?? "");
        } catch (err) {
          this.onError?.(err);
        }
      }
    });
    client.on("error", (err) => {
      this.onError?.(err);
      void this.reconnect();
    });
    client.on("end", () => void this.reconnect());
    await client.connect();
    for (const ch of this.handlers.keys()) await client.query(`LISTEN ${pg.escapeIdentifier(ch)}`);
    this.client = client;
  }

  private async reconnect(): Promise<void> {
    if (this.closed || this.reconnecting) return;
    this.reconnecting = true;
    this.client = null;
    for (let attempt = 0; !this.closed; attempt++) {
      try {
        await new Promise((r) => setTimeout(r, Math.min(10_000, 200 * 2 ** attempt)));
        await this.connect();
        break;
      } catch (err) {
        this.onError?.(err);
      }
    }
    this.reconnecting = false;
  }

  async subscribe(channel: string, handler: (payload: string) => void): Promise<() => void> {
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
      await this.client?.query(`LISTEN ${pg.escapeIdentifier(channel)}`);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.client?.end().catch(() => undefined);
  }
}
