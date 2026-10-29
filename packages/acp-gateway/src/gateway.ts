import { randomUUID } from "node:crypto";
import { deferred, sleep, type Deferred } from "@orrery/core";
import {
  FsService,
  GATEWAY_ERRORS,
  GATEWAY_METHODS,
  JsonRpcError,
  JsonRpcPeer,
  METHODS,
  RPC_ERRORS,
  TerminalService,
  isRecord,
  readOrreryMeta,
  stripOrreryMeta,
  withOrreryMeta,
  type AttachParams,
  type AttachResult,
  type GatewayStatus,
  type InitializeResponse,
  type MessageTransport,
  type PeerLogger,
  type PromptResponse,
  type SessionSetupSnapshot,
} from "@orrery/acp";

/**
 * Orrery ACP gateway — runs inside a bot computer next to the agent process.
 *
 *   worker activity ──WS──▶ gateway ──stdio──▶ kiro-cli acp --agent-engine=v3
 *
 * Responsibilities:
 *  - single long-lived agent process (one initialize, many sessions); restarts it on crash
 *  - multiplexes upstream connections; each session has one *owner* connection
 *  - journals every session notification with a per-session `seq` for replay after re-attach
 *  - holds agent→client requests (permissions, elicitation, OAuth URLs) until an owner answers
 *  - keeps `session/prompt` results by request key so a restarted activity can await them
 *    instead of re-prompting (Kiro: never resend a prompt automatically)
 *  - serves `fs/*` and `terminal/*` locally, jailed to the workspace
 */

export interface AgentProcess {
  transport: MessageTransport;
  pid: number | null;
  exited: Promise<{ code: number | null; signal: string | null }>;
  kill(signal?: NodeJS.Signals): void;
}

export interface GatewayOptions {
  spawnAgent: () => AgentProcess;
  workspaceRoots: string[];
  defaultCwd: string;
  logger?: PeerLogger & { info(obj: object, msg?: string): void };
  /** Notifications kept per session for replay. */
  journalSize?: number;
  /** How long an agent→client request waits for an owner before a safe default answer. */
  holdTimeoutMs?: number;
  /** How long completed prompt results are kept for late awaiters. */
  resultTtlMs?: number;
  /** Answers `_kiro/auth/getAccessToken` locally (tokens never leave the computer). */
  accessTokenProvider?: () => Promise<unknown>;
  /** Extra env for terminals. */
  terminalEnv?: Record<string, string>;
}

interface Upstream {
  id: string;
  peer: JsonRpcPeer;
  connectedAt: number;
  supportsElicitation: boolean;
}

interface SessionRecord {
  sessionId: string;
  owner: Upstream | null;
  seq: number;
  journal: Array<{ seq: number; method: string; params: unknown }>;
  setup: SessionSetupSnapshot | null;
  pendingPrompt: { requestKey: string; startedAt: string } | null;
}

interface HeldRequest {
  id: string;
  method: string;
  params: unknown;
  sessionId: string | null;
  result: Deferred<unknown>;
  deliveredTo: Upstream | null;
  createdAt: number;
  timer: NodeJS.Timeout;
}

interface PromptEntry {
  requestKey: string;
  sessionId: string;
  /** Session journal seq when the prompt was sent (its updates have seq > startSeq). */
  startSeq: number;
  result: Deferred<PromptResponse>;
  completedAt: number | null;
  requester: Upstream | null;
}

const LOCAL_CLIENT_METHODS = new Set<string>([
  METHODS.fsReadTextFile,
  METHODS.fsWriteTextFile,
  METHODS.terminalCreate,
  METHODS.terminalOutput,
  METHODS.terminalWaitForExit,
  METHODS.terminalKill,
  METHODS.terminalRelease,
]);

export class AcpGateway {
  private agent: AgentProcess | null = null;
  private down: JsonRpcPeer | null = null;
  private init: InitializeResponse | null = null;
  private ready = deferred<void>();
  private epoch = randomUUID();
  private restarts = 0;
  private stopping = false;
  private readonly startedAt = new Date().toISOString();
  private readonly upstreams = new Set<Upstream>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly held = new Map<string, HeldRequest>();
  private readonly prompts = new Map<string, PromptEntry>();
  private readonly fs: FsService;
  private readonly terminal: TerminalService;
  private gcTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: GatewayOptions) {
    this.fs = new FsService(opts.workspaceRoots);
    this.terminal = new TerminalService(this.fs, { defaultCwd: opts.defaultCwd, ...(opts.terminalEnv ? { baseEnv: opts.terminalEnv } : {}) });
  }

  private get log() {
    return this.opts.logger ?? { debug() {}, info() {}, warn() {}, error() {} };
  }

  get isReady(): boolean {
    return this.init !== null && this.down !== null && !this.down.isClosed;
  }

  get agentEpoch(): string {
    return this.epoch;
  }

  /* ------------------------------------------------------------------ agent lifecycle */

  async start(): Promise<void> {
    this.gcTimer = setInterval(() => this.gc(), 60_000).unref();
    await this.spawn();
  }

  private async spawn(): Promise<void> {
    this.epoch = randomUUID();
    this.init = null;
    const proc = this.opts.spawnAgent();
    this.agent = proc;
    const down = new JsonRpcPeer(proc.transport, { name: "agent", logger: this.log });
    this.down = down;
    this.registerDownstream(down);
    void proc.exited.then((exit) => this.onAgentExit(proc, exit));
    try {
      const res = await down.request<InitializeResponse>(
        METHODS.initialize,
        {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: true,
            elicitation: { form: {}, url: {} },
            _meta: { kiro: { openExternalUrl: true } },
          },
          clientInfo: { name: "orrery-acp-gateway", version: "0.1.0", title: "Orrery" },
        },
        { timeoutMs: 120_000 },
      );
      this.init = res;
      this.ready.resolve();
      this.log.info({ epoch: this.epoch, agent: res.agentInfo }, "agent initialized");
    } catch (err) {
      this.log.error({ err }, "agent initialize failed");
      proc.kill("SIGKILL");
    }
  }

  private async onAgentExit(proc: AgentProcess, exit: { code: number | null; signal: string | null }): Promise<void> {
    if (this.agent !== proc) return;
    this.log.warn({ exit, epoch: this.epoch }, "agent process exited");
    this.down = null;
    this.init = null;
    this.ready = deferred<void>();
    // Running prompts are lost with the process; awaiters learn it explicitly.
    for (const p of this.prompts.values()) {
      if (!p.result.settled) p.result.reject(new JsonRpcError(GATEWAY_ERRORS.agentRestarted, "agent process restarted", { interrupted: true }));
    }
    for (const s of this.sessions.values()) s.pendingPrompt = null;
    for (const h of this.held.values()) {
      clearTimeout(h.timer);
      if (!h.result.settled) h.result.reject(new JsonRpcError(GATEWAY_ERRORS.agentRestarted, "agent process restarted"));
    }
    this.held.clear();
    this.terminal.releaseAll();
    for (const u of this.upstreams) u.peer.notify("_orrery/gateway/agentRestarted", { previousEpoch: this.epoch });
    if (this.stopping) return;
    this.restarts++;
    await sleep(Math.min(30_000, 500 * 2 ** Math.min(this.restarts, 6)));
    if (!this.stopping) await this.spawn();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.gcTimer) clearInterval(this.gcTimer);
    for (const u of this.upstreams) u.peer.close("gateway stopping");
    this.terminal.releaseAll();
    this.agent?.kill("SIGTERM");
    await Promise.race([this.agent?.exited, sleep(5_000)]);
    this.agent?.kill("SIGKILL");
  }

  /* ------------------------------------------------------------------ downstream (agent) */

  private session(sessionId: string): SessionRecord {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { sessionId, owner: null, seq: 0, journal: [], setup: null, pendingPrompt: null };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  private registerDownstream(down: JsonRpcPeer): void {
    // Local client capabilities: files and terminals live in this computer.
    down.onRequest(METHODS.fsReadTextFile, (p) => this.fs.readTextFile(p as never));
    down.onRequest(METHODS.fsWriteTextFile, (p) => this.fs.writeTextFile(p as never));
    down.onRequest(METHODS.terminalCreate, (p) => this.terminal.create(p as never));
    down.onRequest(METHODS.terminalOutput, (p) => this.terminal.output((p as { terminalId: string }).terminalId));
    down.onRequest(METHODS.terminalWaitForExit, (p, ctx) => this.terminal.waitForExit((p as { terminalId: string }).terminalId, ctx.signal));
    down.onRequest(METHODS.terminalKill, (p) => this.terminal.kill((p as { terminalId: string }).terminalId));
    down.onRequest(METHODS.terminalRelease, (p) => this.terminal.release((p as { terminalId: string }).terminalId));
    if (this.opts.accessTokenProvider) {
      const provider = this.opts.accessTokenProvider;
      down.onRequest("_kiro/auth/getAccessToken", () => provider());
    }

    // Everything else the agent asks goes to the session owner (held until one exists).
    down.setFallbackRequestHandler((params, ctx) => this.holdForOwner(ctx.method, params));

    // Every notification is journaled per session and relayed to the owner.
    down.setFallbackNotificationHandler((params, method) => this.relayNotification(method, params));
  }

  private relayNotification(method: string, params: unknown): void {
    const sessionId = isRecord(params) && typeof params.sessionId === "string" ? params.sessionId : null;
    if (!sessionId) {
      for (const u of this.upstreams) u.peer.notify(method, params);
      return;
    }
    const s = this.session(sessionId);
    s.seq++;
    const entry = { seq: s.seq, method, params };
    s.journal.push(entry);
    const max = this.opts.journalSize ?? 5000;
    if (s.journal.length > max) s.journal.splice(0, s.journal.length - max);
    if (method === METHODS.sessionUpdate) this.trackSetup(s, params);
    s.owner?.peer.notify(method, withOrreryMeta(params, { seq: s.seq }));
  }

  private trackSetup(s: SessionRecord, params: unknown): void {
    const u = isRecord(params) && isRecord(params.update) ? params.update : null;
    if (!u) return;
    s.setup ??= {};
    if (u.sessionUpdate === "config_option_update" && Array.isArray(u.configOptions)) s.setup.configOptions = u.configOptions as never;
    if (u.sessionUpdate === "current_mode_update" && typeof u.currentModeId === "string" && s.setup.modes) s.setup.modes.currentModeId = u.currentModeId;
  }

  private holdForOwner(method: string, params: unknown): Promise<unknown> {
    const sessionId = isRecord(params) && typeof params.sessionId === "string" ? params.sessionId : null;
    const h: HeldRequest = {
      id: randomUUID(),
      method,
      params,
      sessionId,
      result: deferred<unknown>(),
      deliveredTo: null,
      createdAt: Date.now(),
      timer: setTimeout(() => this.expireHeld(h), this.opts.holdTimeoutMs ?? 6 * 3600_000),
    };
    h.timer.unref?.();
    this.held.set(h.id, h);
    this.deliverHeld(h);
    return h.result.promise.finally(() => {
      clearTimeout(h.timer);
      this.held.delete(h.id);
    });
  }

  private ownerFor(h: HeldRequest): Upstream | null {
    if (h.sessionId) return this.sessions.get(h.sessionId)?.owner ?? null;
    // Session-less request: most recently connected upstream.
    let best: Upstream | null = null;
    for (const u of this.upstreams) if (!best || u.connectedAt > best.connectedAt) best = u;
    return best;
  }

  private deliverHeld(h: HeldRequest): void {
    if (h.result.settled || h.deliveredTo) return;
    const owner = this.ownerFor(h);
    if (!owner) return; // wait for attach
    if (h.method === METHODS.elicitationCreate && !owner.supportsElicitation) {
      h.result.resolve({ action: "decline" });
      return;
    }
    h.deliveredTo = owner;
    owner.peer
      .request(h.method, h.params, { timeoutMs: 0, sendCancelRequest: false })
      .then((r) => h.result.resolve(r))
      .catch((err: unknown) => {
        if (owner.peer.isClosed) {
          // Connection dropped before answering: keep holding for the next owner.
          h.deliveredTo = null;
          return;
        }
        h.result.reject(err instanceof JsonRpcError ? err : new JsonRpcError(RPC_ERRORS.internalError, String(err)));
      });
  }

  private expireHeld(h: HeldRequest): void {
    if (h.result.settled) return;
    this.log.warn({ method: h.method, sessionId: h.sessionId }, "agent request expired without an owner");
    if (h.method === METHODS.sessionRequestPermission) h.result.resolve({ outcome: { outcome: "cancelled" } });
    else if (h.method === METHODS.elicitationCreate) h.result.resolve({ action: "cancel" });
    else h.result.reject(new JsonRpcError(RPC_ERRORS.internalError, "no client available to answer"));
  }

  /* ------------------------------------------------------------------ upstream (workers) */

  attachUpstream(transport: MessageTransport, meta: { remote?: string } = {}): void {
    const peer = new JsonRpcPeer(transport, { name: `upstream:${meta.remote ?? "?"}`, logger: this.log });
    const up: Upstream = { id: randomUUID(), peer, connectedAt: Date.now(), supportsElicitation: false };
    this.upstreams.add(up);
    this.log.info({ upstream: up.id, remote: meta.remote }, "upstream connected");

    peer.onClose(() => {
      this.upstreams.delete(up);
      for (const s of this.sessions.values()) if (s.owner === up) s.owner = null;
      for (const p of this.prompts.values()) if (p.requester === up) p.requester = null;
      for (const h of this.held.values()) if (h.deliveredTo === up) h.deliveredTo = null;
      this.log.info({ upstream: up.id }, "upstream disconnected");
    });

    peer.onRequest(METHODS.initialize, async (params) => {
      await this.waitReady();
      up.supportsElicitation = Boolean(isRecord(params) && isRecord(params.clientCapabilities) && params.clientCapabilities.elicitation);
      return this.init;
    });

    peer.onRequest(GATEWAY_METHODS.attach, (params) => this.attach(up, params as AttachParams));
    peer.onRequest(GATEWAY_METHODS.detach, (params) => {
      const s = this.sessions.get((params as { sessionId: string }).sessionId);
      if (s?.owner === up) s.owner = null;
      return {};
    });
    peer.onRequest(GATEWAY_METHODS.awaitPrompt, (params) => this.awaitPrompt(up, (params as { requestKey: string }).requestKey));
    peer.onRequest(GATEWAY_METHODS.status, () => this.status());

    peer.onRequest(METHODS.sessionNew, async (params) => {
      const res = (await this.forward(METHODS.sessionNew, params)) as { sessionId: string } & SessionSetupSnapshot;
      const s = this.session(res.sessionId);
      s.owner = up;
      s.setup = { modes: res.modes ?? null, models: res.models ?? null, configOptions: res.configOptions ?? null };
      return res;
    });

    const loadLike = async (method: string, params: unknown) => {
      const sessionId = (params as { sessionId: string }).sessionId;
      const s = this.session(sessionId);
      s.owner = up; // replay arrives during loading: the owner must be set first
      const res = (await this.forward(method, params)) as SessionSetupSnapshot;
      s.setup = { modes: res?.modes ?? null, models: res?.models ?? null, configOptions: res?.configOptions ?? null };
      for (const h of this.held.values()) if (h.sessionId === sessionId) this.deliverHeld(h);
      return res;
    };
    peer.onRequest(METHODS.sessionLoad, (p) => loadLike(METHODS.sessionLoad, p));
    peer.onRequest(METHODS.sessionResume, (p) => loadLike(METHODS.sessionResume, p));
    peer.onRequest(METHODS.sessionFork, async (params) => {
      const res = (await this.forward(METHODS.sessionFork, params)) as { sessionId: string } & SessionSetupSnapshot;
      const s = this.session(res.sessionId);
      s.owner = up;
      s.setup = { modes: res.modes ?? null, models: res.models ?? null, configOptions: res.configOptions ?? null };
      return res;
    });

    peer.onRequest(METHODS.sessionPrompt, (params) => this.prompt(up, params));

    // Anything else (set_mode, set_config_option, list, `_kiro/*`, `_session/steer`, ...) relays.
    peer.setFallbackRequestHandler((params, ctx) => {
      if (LOCAL_CLIENT_METHODS.has(ctx.method)) throw new JsonRpcError(RPC_ERRORS.methodNotFound, `Method not found: ${ctx.method}`);
      return this.forward(ctx.method, params, ctx.signal);
    });
    peer.setFallbackNotificationHandler((params, method) => {
      if (method === "$/cancel_request") return; // per-request cancellation is mapped in forward()
      this.down?.notify(method, stripOrreryMeta(params));
    });
  }

  private async waitReady(timeoutMs = 120_000): Promise<void> {
    if (this.isReady) return;
    await Promise.race([
      this.ready.promise,
      sleep(timeoutMs).then(() => {
        throw new JsonRpcError(RPC_ERRORS.internalError, "agent not ready");
      }),
    ]);
  }

  private async forward(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    await this.waitReady();
    const down = this.down!;
    return down.request(method, stripOrreryMeta(params), { timeoutMs: 0, ...(signal ? { signal } : {}) });
  }

  private attach(up: Upstream, p: AttachParams): AttachResult {
    const known = this.sessions.has(p.sessionId) && this.isReady;
    const s = this.session(p.sessionId);
    s.owner = up;
    let replayed = 0;
    if (p.afterSeq >= 0) {
      for (const e of s.journal) {
        if (e.seq > p.afterSeq) {
          up.peer.notify(e.method, withOrreryMeta(e.params, { seq: e.seq }));
          replayed++;
        }
      }
    }
    for (const h of this.held.values()) if (h.sessionId === p.sessionId) this.deliverHeld(h);
    const completedKeys = [...this.prompts.values()].filter((x) => x.sessionId === p.sessionId && x.result.settled).map((x) => x.requestKey);
    for (const pr of this.prompts.values()) if (pr.sessionId === p.sessionId && !pr.result.settled) pr.requester = up;
    const asked = p.requestKey ? this.prompts.get(p.requestKey) : undefined;
    return {
      known,
      agentEpoch: this.epoch,
      lastSeq: s.seq,
      replayed,
      pendingPrompt: s.pendingPrompt,
      completedKeys,
      setup: s.setup,
      prompt: asked && asked.sessionId === p.sessionId ? { requestKey: asked.requestKey, startSeq: asked.startSeq, settled: asked.result.settled } : null,
    };
  }

  private async prompt(up: Upstream, params: unknown): Promise<PromptResponse> {
    const sessionId = (params as { sessionId: string }).sessionId;
    const requestKey = readOrreryMeta(params).requestKey ?? `anon_${randomUUID()}`;
    const existing = this.prompts.get(requestKey);
    if (existing) {
      // Idempotency: the same key is never sent to the agent twice.
      existing.requester = up;
      return existing.result.promise;
    }
    const s = this.session(sessionId);
    s.owner = up;
    const entry: PromptEntry = { requestKey, sessionId, startSeq: s.seq, result: deferred<PromptResponse>(), completedAt: null, requester: up };
    this.prompts.set(requestKey, entry);
    s.pendingPrompt = { requestKey, startedAt: new Date().toISOString() };
    this.forward(METHODS.sessionPrompt, params)
      .then((r) => entry.result.resolve(r as PromptResponse))
      .catch((err: unknown) => entry.result.reject(err))
      .finally(() => {
        entry.completedAt = Date.now();
        if (s.pendingPrompt?.requestKey === requestKey) s.pendingPrompt = null;
      });
    return entry.result.promise;
  }

  private awaitPrompt(up: Upstream, requestKey: string): Promise<PromptResponse> {
    const p = this.prompts.get(requestKey);
    if (!p) throw new JsonRpcError(GATEWAY_ERRORS.unknownRequestKey, `unknown request key ${requestKey}`);
    p.requester = up;
    return p.result.promise;
  }

  status(): GatewayStatus {
    return {
      agentEpoch: this.epoch,
      agentPid: this.agent?.pid ?? null,
      agentInfo: this.init?.agentInfo ?? null,
      ready: this.isReady,
      restarts: this.restarts,
      startedAt: this.startedAt,
      sessions: [...this.sessions.values()].map((s) => ({
        sessionId: s.sessionId,
        lastSeq: s.seq,
        owned: s.owner !== null,
        pendingPrompt: s.pendingPrompt?.requestKey ?? null,
        pendingAgentRequests: [...this.held.values()].filter((h) => h.sessionId === s.sessionId).length,
      })),
    };
  }

  metrics(): string {
    const st = this.status();
    const lines = [
      "# TYPE orrery_gateway_ready gauge",
      `orrery_gateway_ready ${st.ready ? 1 : 0}`,
      "# TYPE orrery_gateway_agent_restarts_total counter",
      `orrery_gateway_agent_restarts_total ${st.restarts}`,
      "# TYPE orrery_gateway_sessions gauge",
      `orrery_gateway_sessions ${st.sessions.length}`,
      "# TYPE orrery_gateway_upstreams gauge",
      `orrery_gateway_upstreams ${this.upstreams.size}`,
      "# TYPE orrery_gateway_pending_prompts gauge",
      `orrery_gateway_pending_prompts ${st.sessions.filter((s) => s.pendingPrompt).length}`,
      "# TYPE orrery_gateway_held_requests gauge",
      `orrery_gateway_held_requests ${this.held.size}`,
    ];
    return lines.join("\n") + "\n";
  }

  /** Forget completed prompt results after their TTL. */
  private gc(): void {
    const ttl = this.opts.resultTtlMs ?? 3600_000;
    const now = Date.now();
    for (const [k, p] of this.prompts) if (p.completedAt && now - p.completedAt > ttl) this.prompts.delete(k);
  }

  /** Last-resort idle check used by the computer manager (no owners, nothing running). */
  get idle(): boolean {
    return this.upstreams.size === 0 && ![...this.sessions.values()].some((s) => s.pendingPrompt) && this.held.size === 0;
  }
}
