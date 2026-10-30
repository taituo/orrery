/** Minimal Orrery API client for the CLI: JSON requests and a resumable SSE reader. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface SseEvent {
  id?: string;
  event: string;
  data: string;
}

export class OrreryClient {
  constructor(
    readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  async request<T = unknown>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let r: Response;
    try {
      r = await this.fetchImpl(this.url(path), {
        method,
        headers: { authorization: `Bearer ${this.token}`, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      throw new ApiError(0, "unreachable", `cannot reach ${this.baseUrl}: ${(err as Error).message}`);
    }
    const text = await r.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    if (!r.ok) {
      const e = (json as { error?: { code?: string; message?: string } } | null)?.error;
      throw new ApiError(r.status, e?.code ?? String(r.status), e?.message ?? (text.slice(0, 200) || r.statusText));
    }
    return json as T;
  }

  get<T = unknown>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }
  post<T = unknown>(path: string, body: unknown = {}): Promise<T> {
    return this.request<T>("POST", path, body);
  }
  put<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PUT", path, body);
  }
  patch<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }
  delete<T = unknown>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }

  /**
   * Reads an SSE stream, reconnecting with Last-Event-ID until `signal` aborts. Resolves when
   * aborted. `onEvent` errors stop the stream.
   */
  async stream(path: string, onEvent: (e: SseEvent) => void | Promise<void>, signal: AbortSignal, onReady?: () => void): Promise<void> {
    let lastId: string | undefined;
    let attempt = 0;
    while (!signal.aborted) {
      try {
        const r = await this.fetchImpl(this.url(path), {
          headers: { authorization: `Bearer ${this.token}`, accept: "text/event-stream", ...(lastId ? { "last-event-id": lastId } : {}) },
          signal,
        });
        if (!r.ok || !r.body) {
          const text = await r.text().catch(() => "");
          throw new ApiError(r.status, String(r.status), text.slice(0, 200) || r.statusText);
        }
        attempt = 0;
        const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        let cur: Partial<SseEvent> & { data?: string } = {};
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).replace(/\r$/, "");
            buf = buf.slice(nl + 1);
            if (line === "") {
              if (cur.data !== undefined || cur.event) {
                const ev: SseEvent = { event: cur.event ?? "message", data: cur.data ?? "", ...(cur.id ? { id: cur.id } : {}) };
                if (ev.id) lastId = ev.id;
                if (ev.event === "ready") onReady?.();
                await onEvent(ev);
              }
              cur = {};
            } else if (line.startsWith(":")) {
              /* comment */
            } else {
              const i = line.indexOf(":");
              const field = i < 0 ? line : line.slice(0, i);
              const v = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
              if (field === "data") cur.data = cur.data === undefined ? v : `${cur.data}\n${v}`;
              else if (field === "event") cur.event = v;
              else if (field === "id") cur.id = v;
            }
          }
        }
      } catch (err) {
        if (signal.aborted) return;
        if (err instanceof ApiError && (err.status === 401 || err.status === 403 || err.status === 404)) throw err;
      }
      if (signal.aborted) return;
      await new Promise((res) => setTimeout(res, Math.min(10_000, 500 * 2 ** attempt++)));
    }
  }
}
