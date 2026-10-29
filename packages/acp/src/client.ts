import { KeyedSerialQueue } from "@orrery/core";
import { JsonRpcError, JsonRpcPeer, RPC_ERRORS, type RequestContext } from "./jsonrpc.js";
import {
  ACP_PROTOCOL_VERSION,
  METHODS,
  isRecord,
  type ClientCapabilities,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type ForkSessionRequest,
  type Implementation,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SetSessionConfigOptionResponse,
} from "./protocol.js";
import type { FsService, TerminalService } from "./services.js";

export interface AcpClientHandlers {
  /** Called in arrival order per session (serialized). */
  onSessionUpdate(notification: SessionNotification): void | Promise<void>;
  /** Must resolve with one of the offered options or `cancelled`. */
  onPermissionRequest(request: RequestPermissionRequest, ctx: RequestContext): Promise<RequestPermissionResponse>;
  /** Agent-specific notifications (`_kiro/...`, `_kiro.dev/...`). */
  onExtNotification?(method: string, params: unknown): void | Promise<void>;
  /**
   * Agent-specific requests. Return `undefined` to answer "method not found" (explicit error,
   * as Kiro requires — an agent→client request must never be left hanging).
   */
  onExtRequest?(method: string, params: unknown, ctx: RequestContext): Promise<unknown> | unknown;
  onElicitation?(request: CreateElicitationRequest, ctx: RequestContext): Promise<CreateElicitationResponse>;
  fs?: FsService;
  terminal?: TerminalService;
}

export interface AcpClientOptions {
  clientInfo?: Implementation;
  /** Extra client capability `_meta` (e.g. `{ kiro: { openExternalUrl: true } }`). */
  capabilityMeta?: Record<string, unknown>;
  /** Advertise ACP elicitation support (form/url). */
  elicitation?: boolean;
  requestTimeoutMs?: number;
}

/**
 * Generic ACP client: speaks the standard protocol and exposes typed calls. Agent-specific
 * behaviour lives in adapters (see ./adapters), never here.
 */
export class AcpClient {
  private initResult: InitializeResponse | null = null;
  private readonly updateQueue = new KeyedSerialQueue();

  constructor(
    readonly peer: JsonRpcPeer,
    private readonly handlers: AcpClientHandlers,
    private readonly opts: AcpClientOptions = {},
  ) {
    this.registerHandlers();
  }

  /** Handlers are registered at construction — before any session/new or session/load, as required. */
  private registerHandlers(): void {
    const h = this.handlers;
    this.peer.onNotification(METHODS.sessionUpdate, (params) => {
      const n = params as SessionNotification;
      const key = isRecord(n) && typeof n.sessionId === "string" ? n.sessionId : "_";
      return this.updateQueue.run(key, () => h.onSessionUpdate(n));
    });

    this.peer.onRequest(METHODS.sessionRequestPermission, async (params, ctx) => {
      const req = params as RequestPermissionRequest;
      // Deliver in order with this session's updates, but wait for the decision outside the queue.
      let decision!: Promise<RequestPermissionResponse>;
      await this.updateQueue.run(req.sessionId ?? "_", () => {
        decision = h.onPermissionRequest(req, ctx);
      });
      return decision;
    });

    if (h.fs) {
      const fs = h.fs;
      this.peer.onRequest(METHODS.fsReadTextFile, (p) => fs.readTextFile(p as never));
      this.peer.onRequest(METHODS.fsWriteTextFile, (p) => fs.writeTextFile(p as never));
    }
    if (h.terminal) {
      const t = h.terminal;
      this.peer.onRequest(METHODS.terminalCreate, (p) => t.create(p as never));
      this.peer.onRequest(METHODS.terminalOutput, (p) => t.output((p as { terminalId: string }).terminalId));
      this.peer.onRequest(METHODS.terminalWaitForExit, (p, ctx) => t.waitForExit((p as { terminalId: string }).terminalId, ctx.signal));
      this.peer.onRequest(METHODS.terminalKill, (p) => t.kill((p as { terminalId: string }).terminalId));
      this.peer.onRequest(METHODS.terminalRelease, (p) => t.release((p as { terminalId: string }).terminalId));
    }
    if (h.onElicitation) {
      const e = h.onElicitation;
      this.peer.onRequest(METHODS.elicitationCreate, (p, ctx) => e(p as CreateElicitationRequest, ctx));
    }

    this.peer.setFallbackNotificationHandler((params, method) => {
      if (method.startsWith("_") || method.includes("/")) return h.onExtNotification?.(method, params);
    });
    this.peer.setFallbackRequestHandler(async (params, ctx) => {
      if (h.onExtRequest) {
        const result = await h.onExtRequest(ctx.method, params, ctx);
        if (result !== undefined) return result;
      }
      throw new JsonRpcError(RPC_ERRORS.methodNotFound, `Method not found: ${ctx.method}`);
    });
  }

  /**
   * Wait until every update received so far has been handled. Call after a `session/prompt`
   * response arrives: the agent sends its last updates before the response, and they must be
   * processed before the turn is considered settled.
   */
  drainUpdates(sessionId?: string): Promise<void> {
    return this.updateQueue.whenIdle(sessionId);
  }

  get initialized(): InitializeResponse {
    if (!this.initResult) throw new Error("ACP client not initialized");
    return this.initResult;
  }

  get isInitialized(): boolean {
    return this.initResult !== null;
  }

  clientCapabilities(): ClientCapabilities {
    const caps: ClientCapabilities = {
      fs: { readTextFile: Boolean(this.handlers.fs), writeTextFile: Boolean(this.handlers.fs) },
      terminal: Boolean(this.handlers.terminal),
    };
    if (this.opts.elicitation && this.handlers.onElicitation) caps.elicitation = { form: {}, url: {} };
    if (this.opts.capabilityMeta) caps._meta = this.opts.capabilityMeta;
    return caps;
  }

  async initialize(overrides: Partial<InitializeRequest> = {}): Promise<InitializeResponse> {
    const req: InitializeRequest = {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: this.clientCapabilities(),
      clientInfo: this.opts.clientInfo ?? { name: "orrery", version: "0.1.0", title: "Orrery" },
      ...overrides,
    };
    const res = await this.peer.request<InitializeResponse>(METHODS.initialize, req, { timeoutMs: this.opts.requestTimeoutMs ?? 60_000 });
    if (!isRecord(res) || typeof res.protocolVersion !== "number") {
      throw new JsonRpcError(RPC_ERRORS.internalError, "invalid initialize response");
    }
    if (res.protocolVersion !== ACP_PROTOCOL_VERSION) {
      // ACP: if the agent picks a version we don't support we must close the connection.
      this.peer.close(`unsupported ACP protocol version ${res.protocolVersion}`);
      throw new JsonRpcError(RPC_ERRORS.internalError, `unsupported ACP protocol version ${res.protocolVersion}`);
    }
    this.initResult = res;
    return res;
  }

  /** Kiro V3 extension advertisement: `agentCapabilities._meta.kiro.extensionMethods`. */
  get kiroExtensionMethods(): ReadonlySet<string> {
    const list = (this.initResult?.agentCapabilities?._meta as { kiro?: { extensionMethods?: unknown } } | undefined)?.kiro?.extensionMethods;
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
  }

  authenticate(methodId: string): Promise<unknown> {
    return this.peer.request(METHODS.authenticate, { methodId });
  }

  newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    return this.peer.request(METHODS.sessionNew, params, { timeoutMs: this.opts.requestTimeoutMs ?? 120_000 });
  }

  loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    return this.peer.request(METHODS.sessionLoad, params, { timeoutMs: this.opts.requestTimeoutMs ?? 300_000 });
  }

  resumeSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    return this.peer.request(METHODS.sessionResume, params, { timeoutMs: this.opts.requestTimeoutMs ?? 120_000 });
  }

  listSessions(params: ListSessionsRequest = {}): Promise<ListSessionsResponse> {
    return this.peer.request(METHODS.sessionList, params);
  }

  forkSession(params: ForkSessionRequest): Promise<NewSessionResponse> {
    return this.peer.request(METHODS.sessionFork, params);
  }

  closeSession(sessionId: string): Promise<unknown> {
    return this.peer.request(METHODS.sessionClose, { sessionId });
  }

  /** Long-running: resolves only when the turn ends (stopReason). No timeout by design. */
  prompt(params: PromptRequest): Promise<PromptResponse> {
    return this.peer.request(METHODS.sessionPrompt, params, { timeoutMs: 0 });
  }

  cancel(sessionId: string): void {
    this.peer.notify(METHODS.sessionCancel, { sessionId });
  }

  setMode(sessionId: string, modeId: string): Promise<unknown> {
    return this.peer.request(METHODS.sessionSetMode, { sessionId, modeId });
  }

  setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<SetSessionConfigOptionResponse> {
    const params = typeof value === "boolean" ? { sessionId, configId, type: "boolean" as const, value } : { sessionId, configId, value };
    return this.peer.request(METHODS.sessionSetConfigOption, params);
  }

  /** Legacy (Kiro CLI v2 and older agents). */
  setModel(sessionId: string, modelId: string): Promise<unknown> {
    return this.peer.request(METHODS.sessionSetModel, { sessionId, modelId });
  }

  /** Extension request; `method` must be the full wire name including the leading underscore. */
  ext<T = unknown>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
    return this.peer.request<T>(method, params, { timeoutMs });
  }

  extNotify(method: string, params: unknown): void {
    this.peer.notify(method, params);
  }

  close(reason?: string): void {
    this.handlers.terminal?.releaseAll();
    this.peer.close(reason);
  }
}
