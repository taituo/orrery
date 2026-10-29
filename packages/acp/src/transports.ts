import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import WebSocket, { type RawData } from "ws";
import type { JsonRpcMessage, MessageTransport } from "./jsonrpc.js";

/** Max size of a single JSON-RPC line/frame. Large tool outputs and images fit comfortably. */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

abstract class BaseTransport implements MessageTransport {
  protected messageHandler: ((m: unknown) => void) | null = null;
  protected readonly closeHandlers: Array<(reason?: unknown) => void> = [];
  protected readonly backlog: unknown[] = [];
  private closedFlag = false;

  abstract send(message: JsonRpcMessage): void;
  protected abstract doClose(reason?: string): void;

  onMessage(handler: (message: unknown) => void): void {
    this.messageHandler = handler;
    // deliver anything that arrived before the peer attached
    while (this.backlog.length) handler(this.backlog.shift());
  }

  onClose(handler: (reason?: unknown) => void): void {
    if (this.closedFlag) handler("closed");
    else this.closeHandlers.push(handler);
  }

  get isClosed(): boolean {
    return this.closedFlag;
  }

  close(reason?: string): void {
    if (this.closedFlag) return;
    this.doClose(reason);
    this.markClosed(reason);
  }

  protected deliver(m: unknown): void {
    if (this.messageHandler) this.messageHandler(m);
    else this.backlog.push(m);
  }

  protected markClosed(reason?: unknown): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    for (const h of this.closeHandlers.splice(0)) h(reason);
  }
}

/** Newline-delimited JSON over a pair of byte streams (ACP stdio framing). */
export class NdjsonStreamTransport extends BaseTransport {
  private buffer = "";

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly onParseError: (line: string, err: unknown) => void = () => {},
  ) {
    super();
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => this.onData(chunk));
    input.on("end", () => this.markClosed("input ended"));
    input.on("error", (err) => this.markClosed(err));
    output.on("error", (err) => this.markClosed(err));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_FRAME_BYTES && !this.buffer.includes("\n")) {
      this.onParseError(this.buffer.slice(0, 200), new Error("frame too large"));
      this.buffer = "";
      return;
    }
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        // Agents sometimes print diagnostics on stdout; never let that kill the session.
        this.onParseError(line, err);
        continue;
      }
      this.deliver(parsed);
    }
  }

  send(message: JsonRpcMessage): void {
    if (this.isClosed) return;
    this.output.write(JSON.stringify(message) + "\n");
  }

  protected doClose(): void {
    this.output.end();
  }
}

export interface SpawnedAgent {
  transport: NdjsonStreamTransport;
  child: ChildProcessWithoutNullStreams;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill(signal?: NodeJS.Signals): void;
}

export interface SpawnAgentOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  onStderr?: (line: string) => void;
  onParseError?: (line: string, err: unknown) => void;
}

/** Spawn an ACP agent (e.g. `kiro-cli acp --agent-engine=v3`) and speak NDJSON over its stdio. */
export function spawnAgent(opts: SpawnAgentOptions): SpawnedAgent {
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const transport = new NdjsonStreamTransport(child.stdout, child.stdin, opts.onParseError);
  let errBuf = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    errBuf += chunk;
    let nl: number;
    while ((nl = errBuf.indexOf("\n")) >= 0) {
      const line = errBuf.slice(0, nl);
      errBuf = errBuf.slice(nl + 1);
      if (line.trim()) opts.onStderr?.(line);
    }
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
    child.on("error", () => resolve({ code: -1, signal: null }));
  });
  void exited.then((r) => transport.close(`agent exited (code=${r.code}, signal=${r.signal})`));
  return {
    transport,
    child,
    exited,
    kill: (signal: NodeJS.Signals = "SIGTERM") => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    },
  };
}

/** One JSON-RPC message per WebSocket text frame. Works for both client and server sockets. */
export class WebSocketTransport extends BaseTransport {
  constructor(private readonly ws: WebSocket) {
    super();
    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      const text = data.toString();
      try {
        this.deliver(JSON.parse(text));
      } catch {
        // ignore malformed frames
      }
    });
    ws.on("close", (code, reason) => this.markClosed(`ws closed ${code} ${reason.toString()}`));
    ws.on("error", (err) => this.markClosed(err));
  }

  send(message: JsonRpcMessage): void {
    if (this.isClosed || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(message));
  }

  protected doClose(reason?: string): void {
    try {
      this.ws.close(1000, reason?.slice(0, 120));
    } catch {
      this.ws.terminate();
    }
  }
}

export interface ConnectWebSocketOptions {
  url: string;
  token?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Optional TLS CA (PEM) for in-cluster mTLS / private CAs. */
  ca?: string;
}

export function connectWebSocket(opts: ConnectWebSocketOptions): Promise<WebSocketTransport> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(opts.url, {
      headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...opts.headers },
      handshakeTimeout: opts.timeoutMs ?? 10_000,
      maxPayload: MAX_FRAME_BYTES,
      ...(opts.ca ? { ca: opts.ca } : {}),
    });
    const onError = (err: Error) => reject(err);
    ws.once("error", onError);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`gateway handshake failed: HTTP ${res.statusCode}`)));
    ws.once("open", () => {
      ws.off("error", onError);
      resolve(new WebSocketTransport(ws));
    });
  });
}

/** In-memory transport pair (tests and in-process wiring). */
export function memoryTransportPair(): [MessageTransport, MessageTransport] {
  class MemoryTransport extends BaseTransport {
    other: MemoryTransport | null = null;
    send(message: JsonRpcMessage): void {
      if (this.isClosed) return;
      const target = this.other;
      // structuredClone: no shared object references across the "wire"
      const copy = JSON.parse(JSON.stringify(message)) as unknown;
      queueMicrotask(() => target?.receive(copy));
    }
    receive(m: unknown): void {
      if (!this.isClosed) this.deliver(m);
    }
    protected doClose(reason?: string): void {
      const o = this.other;
      queueMicrotask(() => o?.remoteClosed(reason));
    }
    remoteClosed(reason?: string): void {
      this.markClosed(reason ?? "remote closed");
    }
  }
  const a = new MemoryTransport();
  const b = new MemoryTransport();
  a.other = b;
  b.other = a;
  return [a, b];
}
