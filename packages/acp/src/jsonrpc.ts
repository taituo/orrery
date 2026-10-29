/**
 * Minimal, strict JSON-RPC 2.0 peer used for every ACP connection (stdio and WebSocket,
 * client and gateway side). Written in-house rather than wrapping an SDK so that:
 *   - unknown methods, fields and `_meta` pass through untouched (relays/replay),
 *   - every agent→client request gets a response or an explicit error (never hangs),
 *   - request ids can be remapped by the gateway,
 *   - cancellation maps onto ACP `$/cancel_request` when the peer supports it.
 */
export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}
export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  result?: unknown;
  error?: JsonRpcErrorObject;
}
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export const RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** ACP: request cancelled by the requester. */
  requestCancelled: -32800,
  /** ACP: authentication required. */
  authRequired: -32000,
} as const;

export class JsonRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "JsonRpcError";
    this.code = code;
    this.data = data;
  }
  toObject(): JsonRpcErrorObject {
    return { code: this.code, message: this.message, ...(this.data === undefined ? {} : { data: this.data }) };
  }
}

export interface MessageTransport {
  send(message: JsonRpcMessage): void;
  /** Register the single inbound handler. */
  onMessage(handler: (message: unknown) => void): void;
  onClose(handler: (reason?: unknown) => void): void;
  close(reason?: string): void;
  readonly isClosed: boolean;
}

export interface RequestContext {
  id: JsonRpcId;
  method: string;
  /** Aborted when the peer sends `$/cancel_request` for this id or the connection closes. */
  signal: AbortSignal;
}

export type RequestHandler = (params: unknown, ctx: RequestContext) => Promise<unknown> | unknown;
export type NotificationHandler = (params: unknown, method: string) => void | Promise<void>;

export interface PeerLogger {
  debug(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

const noopLogger: PeerLogger = { debug() {}, warn() {}, error() {} };

interface Pending {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer?: NodeJS.Timeout;
  cleanup?: () => void;
}

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Send `$/cancel_request` when the signal aborts (ACP stable). Default true. */
  sendCancelRequest?: boolean;
}

export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  private readonly inflightInbound = new Map<JsonRpcId, AbortController>();
  private fallbackRequest: RequestHandler | null = null;
  private fallbackNotification: NotificationHandler | null = null;
  private closedReason: unknown = undefined;
  private readonly closeListeners: Array<(reason?: unknown) => void> = [];
  readonly closed: Promise<unknown>;
  private resolveClosed!: (reason: unknown) => void;
  /** Observes every inbound message before dispatch (used for tracing / journaling). */
  tap: ((direction: "in" | "out", message: JsonRpcMessage) => void) | null = null;

  constructor(
    private readonly transport: MessageTransport,
    private readonly opts: { name?: string; logger?: PeerLogger; defaultTimeoutMs?: number } = {},
  ) {
    this.closed = new Promise((resolve) => (this.resolveClosed = resolve));
    transport.onMessage((m) => this.handleIncoming(m));
    transport.onClose((reason) => this.handleClose(reason));
  }

  private get log(): PeerLogger {
    return this.opts.logger ?? noopLogger;
  }

  get isClosed(): boolean {
    return this.transport.isClosed || this.closedReason !== undefined;
  }

  onRequest(method: string, handler: RequestHandler): this {
    this.requestHandlers.set(method, handler);
    return this;
  }

  onNotification(method: string, handler: NotificationHandler): this {
    this.notificationHandlers.set(method, handler);
    return this;
  }

  /** Called for requests without a dedicated handler. Return value is the result; throw JsonRpcError to fail. */
  setFallbackRequestHandler(handler: RequestHandler | null): this {
    this.fallbackRequest = handler;
    return this;
  }

  setFallbackNotificationHandler(handler: NotificationHandler | null): this {
    this.fallbackNotification = handler;
    return this;
  }

  onClose(listener: (reason?: unknown) => void): void {
    if (this.closedReason !== undefined) listener(this.closedReason);
    else this.closeListeners.push(listener);
  }

  request<T = unknown>(method: string, params?: unknown, options: RequestOptions = {}): Promise<T> {
    if (this.isClosed) return Promise.reject(new JsonRpcError(RPC_ERRORS.internalError, `connection closed (${method})`));
    const id = this.nextId++;
    const message: JsonRpcRequest = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { method, resolve: resolve as (v: unknown) => void, reject };
      const timeoutMs = options.timeoutMs ?? this.opts.defaultTimeoutMs;
      if (timeoutMs && timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new JsonRpcError(RPC_ERRORS.internalError, `request timed out after ${timeoutMs}ms (${method})`));
        }, timeoutMs);
      }
      if (options.signal) {
        const signal = options.signal;
        const onAbort = () => {
          if (!this.pending.has(id)) return;
          if (options.sendCancelRequest !== false) this.notify("$/cancel_request", { requestId: id });
          // keep waiting for the peer's response (ACP: cancellation still yields a response)
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
        entry.cleanup = () => signal.removeEventListener("abort", onAbort);
      }
      this.pending.set(id, entry);
      this.write(message);
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.isClosed) return;
    this.write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  /** Low-level: send a raw response (used by the gateway when relaying). */
  respond(id: JsonRpcId, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result: result === undefined ? null : result });
  }

  respondError(id: JsonRpcId | null, error: JsonRpcErrorObject): void {
    this.write({ jsonrpc: "2.0", id, error });
  }

  close(reason = "closed by peer"): void {
    this.transport.close(reason);
    this.handleClose(reason);
  }

  private write(message: JsonRpcMessage): void {
    try {
      this.tap?.("out", message);
    } catch {
      /* tap must never break the connection */
    }
    this.transport.send(message);
  }

  private handleClose(reason: unknown): void {
    if (this.closedReason !== undefined) return;
    this.closedReason = reason ?? "closed";
    for (const [id, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.cleanup?.();
      p.reject(new JsonRpcError(RPC_ERRORS.internalError, `connection closed before response (${p.method})`, { reason: String(reason) }));
      this.pending.delete(id);
    }
    for (const ac of this.inflightInbound.values()) ac.abort(new Error("connection closed"));
    this.inflightInbound.clear();
    for (const l of this.closeListeners.splice(0)) {
      try {
        l(reason);
      } catch {
        /* ignore */
      }
    }
    this.resolveClosed(reason);
  }

  private handleIncoming(raw: unknown): void {
    if (typeof raw !== "object" || raw === null) {
      this.respondError(null, { code: RPC_ERRORS.parseError, message: "Parse error" });
      return;
    }
    const msg = raw as Record<string, unknown>;
    try {
      this.tap?.("in", msg as unknown as JsonRpcMessage);
    } catch {
      /* ignore */
    }
    const hasMethod = typeof msg.method === "string";
    const hasId = "id" in msg && msg.id !== undefined && msg.id !== null;

    if (hasMethod && hasId) {
      void this.dispatchRequest(msg.id as JsonRpcId, msg.method as string, msg.params);
      return;
    }
    if (hasMethod) {
      this.dispatchNotification(msg.method as string, msg.params);
      return;
    }
    if ("id" in msg && ("result" in msg || "error" in msg)) {
      this.dispatchResponse(msg as unknown as JsonRpcResponse);
      return;
    }
    this.log.warn({ peer: this.opts.name, msg }, "invalid JSON-RPC message");
    if (hasId) this.respondError(msg.id as JsonRpcId, { code: RPC_ERRORS.invalidRequest, message: "Invalid Request" });
  }

  private dispatchResponse(res: JsonRpcResponse): void {
    if (res.id === null) {
      this.log.warn({ peer: this.opts.name, error: res.error }, "peer reported error without id");
      return;
    }
    const p = this.pending.get(res.id);
    if (!p) {
      this.log.debug({ peer: this.opts.name, id: res.id }, "response for unknown request id");
      return;
    }
    this.pending.delete(res.id);
    if (p.timer) clearTimeout(p.timer);
    p.cleanup?.();
    if (res.error) p.reject(new JsonRpcError(res.error.code, res.error.message, res.error.data));
    else p.resolve(res.result);
  }

  private dispatchNotification(method: string, params: unknown): void {
    if (method === "$/cancel_request") {
      const id = (params as { requestId?: JsonRpcId } | undefined)?.requestId;
      if (id !== undefined) this.inflightInbound.get(id)?.abort(new Error("cancelled by peer"));
      // fall through to user handler too (gateway relays it)
    }
    const handler = this.notificationHandlers.get(method) ?? this.fallbackNotification;
    if (!handler) {
      this.log.debug({ peer: this.opts.name, method }, "unhandled notification ignored");
      return;
    }
    try {
      const r = handler(params, method);
      if (r && typeof (r as Promise<void>).then === "function") {
        (r as Promise<void>).catch((err: unknown) => this.log.error({ peer: this.opts.name, method, err }, "notification handler failed"));
      }
    } catch (err) {
      this.log.error({ peer: this.opts.name, method, err }, "notification handler failed");
    }
  }

  private async dispatchRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    const handler = this.requestHandlers.get(method) ?? this.fallbackRequest;
    if (!handler) {
      // ACP/Kiro rule: unsupported agent→client requests must get an explicit error, never silence.
      this.respondError(id, { code: RPC_ERRORS.methodNotFound, message: `Method not found: ${method}` });
      return;
    }
    const ac = new AbortController();
    this.inflightInbound.set(id, ac);
    try {
      const result = await handler(params, { id, method, signal: ac.signal });
      if (!this.isClosed) this.respond(id, result);
    } catch (err) {
      if (this.isClosed) return;
      if (err instanceof JsonRpcError) this.respondError(id, err.toObject());
      else if (ac.signal.aborted) this.respondError(id, { code: RPC_ERRORS.requestCancelled, message: "Request cancelled" });
      else {
        this.log.error({ peer: this.opts.name, method, err }, "request handler failed");
        this.respondError(id, { code: RPC_ERRORS.internalError, message: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      this.inflightInbound.delete(id);
    }
  }
}
