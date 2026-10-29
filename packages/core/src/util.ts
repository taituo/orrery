import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** Full-jitter exponential backoff. */
export function backoffMs(attempt: number, baseMs = 250, maxMs = 20_000): number {
  const exp = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.floor(Math.random() * exp);
}

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + "…";
}

/** Rough token estimate for budgeting (≈4 chars/token for English text). */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/** A promise with externally accessible resolve/reject. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  settled: boolean;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const d = { settled: false } as Deferred<T>;
  d.promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  d.resolve = (v) => {
    if (d.settled) return;
    d.settled = true;
    resolve(v);
  };
  d.reject = (e) => {
    if (d.settled) return;
    d.settled = true;
    reject(e);
  };
  return d;
}

/** Strictly ordered async execution per key (used to keep each ACP session's updates in order). */
export class KeyedSerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run(key: string, task: () => Promise<void> | void): Promise<void> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(task, task).catch(() => undefined);
    this.tails.set(key, next);
    void next.finally(() => {
      if (this.tails.get(key) === next) this.tails.delete(key);
    });
    return next;
  }

  /** Resolves once everything queued so far (for one key, or all keys) has run. */
  async whenIdle(key?: string): Promise<void> {
    if (key !== undefined) {
      await this.tails.get(key);
      return;
    }
    await Promise.all([...this.tails.values()]);
  }
}

/** Unbounded async queue with an async iterator; `close()` ends iteration. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()!({ value: undefined as never, done: true });
  }

  get size(): number {
    return this.items.length;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}

/* ---------------------------------------------------------------------------------------- */
/* Compact signed tokens (HMAC-SHA256), used for bot-scoped MCP tokens and gateway access.    */
/* Format: base64url(json payload) + "." + base64url(hmac). Payload must carry `exp` (unix s). */
/* ---------------------------------------------------------------------------------------- */

export interface SignedTokenPayload {
  sub: string;
  aud: string;
  exp: number;
  [k: string]: unknown;
}

export function signToken(payload: SignedTokenPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyToken<T extends SignedTokenPayload = SignedTokenPayload>(
  token: string,
  secret: string,
  expectedAud: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): T | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(body).digest();
  let given: Buffer;
  try {
    given = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload: T;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
  if (payload.aud !== expectedAud) return null;
  if (typeof payload.exp !== "number" || payload.exp < nowSec) return null;
  return payload;
}
