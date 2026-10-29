import { OrreryError, backoffMs, sleep } from "@orrery/core";

export interface HttpOptions {
  timeoutMs: number;
  retries?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

function combine(signals: Array<AbortSignal | undefined>): AbortSignal {
  return AbortSignal.any(signals.filter((s): s is AbortSignal => Boolean(s)));
}

function retryAfterMs(res: Response): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return secs * 1000;
  const date = Date.parse(h);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

/** POST JSON with timeout, retry on 408/409/429/5xx and network errors (full-jitter backoff). */
export async function postJson<T>(url: string, body: unknown, opts: HttpOptions): Promise<T> {
  const res = await request(url, { method: "POST", body: JSON.stringify(body) }, opts);
  return (await res.json()) as T;
}

export async function getJson<T>(url: string, opts: HttpOptions): Promise<T> {
  const res = await request(url, { method: "GET" }, opts);
  return (await res.json()) as T;
}

/** Returns the raw Response (for streaming). Retries only before the body is consumed. */
export async function request(url: string, init: { method: string; body?: string }, opts: HttpOptions): Promise<Response> {
  const retries = opts.retries ?? 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const signal = combine([AbortSignal.timeout(opts.timeoutMs), opts.signal]);
    try {
      const res = await fetch(url, {
        method: init.method,
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...opts.headers },
        ...(init.body !== undefined ? { body: init.body } : {}),
        signal,
      });
      if (res.ok) return res;
      const text = await res.text().catch(() => "");
      const retryable = res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500;
      const err = new OrreryError(res.status === 429 ? "rate_limited" : retryable ? "provider_unavailable" : "provider_error", `HTTP ${res.status} from ${new URL(url).host}: ${text.slice(0, 500)}`, {
        details: { status: res.status },
        retryable,
      });
      if (!retryable || attempt === retries) throw err;
      lastErr = err;
      await sleep(retryAfterMs(res) ?? backoffMs(attempt), opts.signal);
    } catch (err) {
      if (err instanceof OrreryError) throw err;
      if (opts.signal?.aborted) throw new OrreryError("cancelled", "request cancelled", { cause: err });
      lastErr = err;
      if (attempt === retries) break;
      await sleep(backoffMs(attempt), opts.signal);
    }
  }
  throw new OrreryError("provider_unavailable", `request to ${new URL(url).host} failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`, { cause: lastErr });
}

/** Parse a `text/event-stream` body into `data:` payloads. */
export async function* readSse(res: Response): AsyncGenerator<string> {
  if (!res.body) return;
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
      const event = buf.slice(0, idx);
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, "");
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data) yield data;
    }
  }
  const tail = buf.trim();
  if (tail.startsWith("data:")) yield tail.slice(5).trimStart();
}
