import { OrreryError, sleep, type AgentEvent, type ContentPart } from "@orrery/core";
import type { AgentAdapter, NormalizedPermission, PermissionDecision, SessionInput, SessionSetup } from "./adapters/types.js";
import { AcpClient } from "./client.js";
import { GATEWAY_ERRORS, GATEWAY_METHODS, readOrreryMeta, type AttachResult } from "./gateway-protocol.js";
import { JsonRpcError, JsonRpcPeer, type MessageTransport, type PeerLogger } from "./jsonrpc.js";
import { usageFromWire } from "./normalize.js";
import type { CreateElicitationRequest, CreateElicitationResponse, PromptResponse } from "./protocol.js";
import type { FsService, TerminalService } from "./services.js";

/**
 * Runs exactly one agent turn over ACP and turns everything that happens into normalized
 * AgentEvents. Used by the Temporal `runAcpTurn` activity (through the bot computer's gateway)
 * and by local development (direct stdio).
 *
 * Guarantees:
 *  - the prompt is sent at most once per `requestKey`; reconnects re-attach and await it
 *  - handlers are registered before session/new|load (no lost replay/live updates)
 *  - the turn settles only from the session/prompt response (never from TurnEnd-like updates)
 *  - cancellation: pending permissions → cancelled, then session/cancel, then await the response
 *  - content updates outside an in-flight prompt are treated as replay and not re-emitted
 */

export interface TurnRunnerDeps {
  /** Open a fresh transport (stdio spawn or gateway WebSocket). Called again on reconnect. */
  connect(): Promise<MessageTransport>;
  adapter: AgentAdapter;
  /** True when talking to an Orrery ACP gateway (enables attach / awaitPrompt / seq dedupe). */
  viaGateway: boolean;
  logger?: PeerLogger;
  /** Client-side services; only for direct mode (the gateway serves fs/terminal itself). */
  fs?: FsService;
  terminal?: TerminalService;
  /** Reconnect attempts when the gateway connection drops mid-turn. */
  maxReconnects?: number;
  /** After session/cancel, how long to wait for the prompt response before giving up. */
  cancelGraceMs?: number;
}

export interface TurnInput {
  /** Idempotency key for this turn (the run id). */
  requestKey: string;
  /** Assistant message id to attach streamed chunks to. */
  messageId: string;
  /** Agent session bound to the thread, if any. */
  sessionId?: string | null;
  session: SessionInput;
  prompt: ContentPart[];
  /** Used instead of `prompt` when a brand-new agent session had to be created (adds history). */
  promptForNewSession?: ContentPart[];
  /** Present when the activity is retried after a crash: resume instead of re-prompting. */
  resume?: { sessionId: string; afterSeq: number; agentEpoch: string | null; promptSent: boolean } | null;
}

export interface TurnProgress {
  sessionId: string | null;
  lastSeq: number;
  agentEpoch: string | null;
  promptSent: boolean;
}

export interface TurnController {
  steer(parts: ContentPart[]): Promise<boolean>;
  compact(): Promise<boolean>;
}

export interface TurnCallbacks {
  onEvent(event: AgentEvent): void | Promise<void>;
  decidePermission(perm: NormalizedPermission, signal: AbortSignal): Promise<PermissionDecision>;
  onProgress?(p: TurnProgress): void;
  onReady?(controller: TurnController): void;
  onElicitation?(req: CreateElicitationRequest, signal: AbortSignal): Promise<CreateElicitationResponse>;
}

export interface TurnResult {
  sessionId: string;
  createdSession: boolean;
  stopReason: PromptResponse["stopReason"] | "interrupted";
  agentEpoch: string | null;
  lastSeq: number;
  setup: SessionSetup | null;
}

const CONTENT_EVENTS = new Set<AgentEvent["type"]>(["message.delta", "thought.delta", "user.echo", "tool.call", "tool.update", "tool.preview", "plan"]);

export async function runAcpTurn(deps: TurnRunnerDeps, input: TurnInput, cb: TurnCallbacks, signal: AbortSignal): Promise<TurnResult> {
  const state = {
    sessionId: (input.resume?.sessionId ?? input.sessionId ?? null) as string | null,
    lastSeq: input.resume?.afterSeq ?? -1,
    agentEpoch: input.resume?.agentEpoch ?? null,
    promptInFlight: false,
    adopt: null as { replayFrom: number } | null,
    promptSent: false,
    createdSession: false,
    setup: null as SessionSetup | null,
  };
  const pendingPermissions = new Set<AbortController>();
  let client: AcpClient | null = null;

  const progress = () => cb.onProgress?.({ sessionId: state.sessionId, lastSeq: state.lastSeq, agentEpoch: state.agentEpoch, promptSent: state.promptSent });

  const emit = async (e: AgentEvent) => {
    if (CONTENT_EVENTS.has(e.type) && !state.promptInFlight) return; // replay / stray
    if ("replay" in e && e.replay) return;
    if (e.type === "config.changed" && state.setup) state.setup.configOptions = e.options as never;
    if (e.type === "mode.changed" && state.setup?.modes) state.setup.modes.currentModeId = e.modeId;
    await cb.onEvent(e);
  };

  /** Dedupe by gateway seq; returns false when already seen. */
  const accept = (params: unknown): boolean => {
    if (!deps.viaGateway) return true;
    const { seq } = readOrreryMeta(params);
    if (typeof seq !== "number") return true;
    if (seq <= state.lastSeq) return false;
    state.lastSeq = seq;
    return true;
  };

  const connect = async (): Promise<AcpClient> => {
    const transport = await deps.connect();
    const peer = new JsonRpcPeer(transport, { name: "acp-client", ...(deps.logger ? { logger: deps.logger } : {}) });
    const c = new AcpClient(
      peer,
      {
        onSessionUpdate: async (n) => {
          if (state.sessionId && n.sessionId !== state.sessionId) return;
          if (!accept(n)) return;
          for (const e of deps.adapter.normalizeUpdate(n, { messageId: input.messageId })) await emit(e);
          progress();
        },
        onPermissionRequest: async (req, ctx) => {
          const perm = deps.adapter.parsePermission(req);
          const ac = new AbortController();
          pendingPermissions.add(ac);
          const abort = () => ac.abort(new Error("turn cancelled"));
          ctx.signal.addEventListener("abort", abort, { once: true });
          signal.addEventListener("abort", abort, { once: true });
          try {
            const decision = await cb.decidePermission(perm, ac.signal).catch((err: unknown): PermissionDecision => {
              if (ac.signal.aborted) return { outcome: "cancelled" };
              throw err;
            });
            return deps.adapter.permissionResponse(perm, decision);
          } finally {
            pendingPermissions.delete(ac);
            ctx.signal.removeEventListener("abort", abort);
            signal.removeEventListener("abort", abort);
          }
        },
        onExtNotification: async (method, params) => {
          if (!accept(params)) return;
          const res = deps.adapter.normalizeExtNotification(method, params);
          if (!res) return;
          if (res.sessionId && state.sessionId && res.sessionId !== state.sessionId) return;
          for (const e of res.events) await emit(e);
        },
        onExtRequest: (method, params) => deps.adapter.handleExtRequest?.(method, params, (e) => void emit(e)),
        onElicitation: async (req, ctx) => {
          if (!cb.onElicitation) return { action: "decline" };
          return cb.onElicitation(req, ctx.signal);
        },
        ...(deps.fs ? { fs: deps.fs } : {}),
        ...(deps.terminal ? { terminal: deps.terminal } : {}),
      },
      { elicitation: Boolean(cb.onElicitation) },
    );
    const base = { protocolVersion: 1, clientCapabilities: c.clientCapabilities(), clientInfo: { name: "orrery", version: "0.1.0", title: "Orrery" } };
    const init = await c.initialize(deps.adapter.initializeRequest(base));
    deps.adapter.onInitialized(init);
    return c;
  };

  const attach = async (c: AcpClient, sessionId: string, afterSeq: number): Promise<AttachResult> =>
    c.ext<AttachResult>(GATEWAY_METHODS.attach, { sessionId, afterSeq, requestKey: input.requestKey });

  const awaitPrompt = (c: AcpClient, requestKey: string): Promise<PromptResponse> =>
    c.ext<PromptResponse>(GATEWAY_METHODS.awaitPrompt, { requestKey }, 0);

  try {
    client = await connect();
    cb.onReady?.({
      steer: async (parts) => (client && state.sessionId ? deps.adapter.steer(client, state.sessionId, parts) : false),
      compact: async () => (client && state.sessionId ? deps.adapter.compact(client, state.sessionId) : false),
    });

    let response: PromptResponse | null = null;

    // ---------------------------------------------------------------- resume after a crash
    if (input.resume?.promptSent) {
      if (!deps.viaGateway) {
        await cb.onEvent({ type: "turn.interrupted", reason: "worker restarted; direct agent connection was lost", resumable: true });
        return { sessionId: input.resume.sessionId, createdSession: false, stopReason: "interrupted", agentEpoch: null, lastSeq: state.lastSeq, setup: null };
      }
      // The journal replay that answers this attach is this turn's own output: accept it as live.
      state.promptInFlight = true;
      const a = await attach(client, input.resume.sessionId, input.resume.afterSeq);
      state.agentEpoch = a.agentEpoch;
      state.setup = a.setup ?? null;
      const sameProcess = a.known && (input.resume.agentEpoch === null || a.agentEpoch === input.resume.agentEpoch);
      if (sameProcess && (a.prompt || a.pendingPrompt?.requestKey === input.requestKey || a.completedKeys.includes(input.requestKey))) {
        state.promptSent = true;
        progress();
        try {
          response = await awaitPrompt(client, input.requestKey);
          await client.drainUpdates();
        } catch (err) {
          if (err instanceof JsonRpcError && (err.code === GATEWAY_ERRORS.agentRestarted || err.code === GATEWAY_ERRORS.unknownRequestKey)) {
            await cb.onEvent({ type: "turn.interrupted", reason: err.message, resumable: err.code === GATEWAY_ERRORS.agentRestarted });
            return { sessionId: input.resume.sessionId, createdSession: false, stopReason: "interrupted", agentEpoch: state.agentEpoch, lastSeq: state.lastSeq, setup: null };
          }
          throw err;
        } finally {
          state.promptInFlight = false;
        }
      } else {
        state.promptInFlight = false;
        // Never resend: Kiro warns a resent prompt can repeat side effects.
        await cb.onEvent({
          type: "turn.interrupted",
          reason: sameProcess ? "turn result no longer available on the agent" : "agent process restarted during the turn",
          resumable: !sameProcess,
        });
        return { sessionId: input.resume.sessionId, createdSession: false, stopReason: "interrupted", agentEpoch: state.agentEpoch, lastSeq: state.lastSeq, setup: null };
      }
    }

    // ---------------------------------------------------------------- open the session
    if (!response) {
      await openSession(client);
      if (signal.aborted) throw new OrreryError("cancelled", "turn cancelled before prompt");
      // A previous attempt already sent this prompt (its checkpoint never reached us): adopt it —
      // replay its output from the gateway journal and wait for its result. Never re-prompt.
      response = state.adopt ? await sendPrompt(client, state.adopt) : await sendPrompt(client);
    }

    const usage = usageFromWire(response.usage);
    const stop = response.stopReason;
    await cb.onEvent({
      type: "turn.completed",
      stopReason: (["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"].includes(stop) ? stop : "end_turn") as never,
      ...(usage ? { usage } : {}),
      ...(stop === "refusal" ? { refusal: true } : {}),
    });
    return {
      sessionId: state.sessionId!,
      createdSession: state.createdSession,
      stopReason: stop,
      agentEpoch: state.agentEpoch,
      lastSeq: state.lastSeq,
      setup: state.setup,
    };
  } finally {
    for (const ac of pendingPermissions) ac.abort(new Error("turn finished"));
    if (deps.viaGateway) client?.close("turn finished");
    // In direct mode the caller owns the process lifecycle (it may keep the agent warm).
  }

  async function openSession(c: AcpClient): Promise<void> {
    const adapter = deps.adapter;
    if (state.sessionId) {
      if (deps.viaGateway) {
        const a = await attach(c, state.sessionId, -1);
        state.agentEpoch = a.agentEpoch;
        if (a.known && a.prompt) state.adopt = { replayFrom: Math.max(input.resume?.afterSeq ?? -1, a.prompt.startSeq) };
        state.lastSeq = Math.max(state.lastSeq, a.lastSeq);
        if (a.known) {
          state.setup = a.setup ?? null;
          await configure(c);
          return;
        }
      }
      if (adapter.supports("loadSession")) {
        try {
          const res = await c.loadSession(adapter.loadSessionParams(state.sessionId, input.session));
          state.setup = adapter.captureSetup(res);
          await configure(c);
          return;
        } catch (err) {
          await cb.onEvent({
            type: "notice",
            severity: "warning",
            title: "Previous agent session could not be restored; starting a new one",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    const res = await c.newSession(adapter.newSessionParams(input.session));
    state.sessionId = res.sessionId;
    state.createdSession = true;
    state.setup = adapter.captureSetup(res);
    if (deps.viaGateway) {
      const a = await attach(c, res.sessionId, -1);
      state.agentEpoch = a.agentEpoch;
      state.lastSeq = a.lastSeq;
    }
    await configure(c);
    progress();
  }

  async function configure(c: AcpClient): Promise<void> {
    if (!state.setup || !state.sessionId) return;
    try {
      for (const e of await deps.adapter.configure(c, state.sessionId, state.setup, input.session.binding)) await cb.onEvent(e);
    } catch (err) {
      await cb.onEvent({ type: "notice", severity: "warning", title: "Could not apply model/mode settings", message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function sendPrompt(c0: AcpClient, adopt?: { replayFrom: number }): Promise<PromptResponse> {
    const sessionId = state.sessionId!;
    const prompt = state.createdSession && input.promptForNewSession ? input.promptForNewSession : input.prompt;
    if (!adopt) {
      await cb.onEvent({
        type: "turn.started",
        provider: deps.adapter.name,
        sessionId,
        engine: deps.adapter.name,
        ...(state.setup?.models?.currentModelId ? { model: state.setup.models.currentModelId } : {}),
      });
    }
    state.promptInFlight = true;
    state.promptSent = true;
    progress();
    let c = c0;
    let promise: Promise<PromptResponse>;
    if (adopt) {
      state.lastSeq = adopt.replayFrom;
      await attach(c, sessionId, adopt.replayFrom);
      promise = awaitPrompt(c, input.requestKey);
    } else {
      promise = c.prompt({ sessionId, prompt, ...(deps.viaGateway ? { _meta: { orrery: { requestKey: input.requestKey } } } : {}) });
    }

    let cancelSent = false;
    const onAbort = () => {
      if (cancelSent) return;
      cancelSent = true;
      for (const ac of pendingPermissions) ac.abort(new Error("turn cancelled"));
      try {
        c.cancel(sessionId);
      } catch {
        /* connection may be gone */
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();

    try {
      for (let attempt = 0; ; attempt++) {
        try {
          let result: PromptResponse;
          if (cancelSent) {
            const grace = deps.cancelGraceMs ?? 60_000;
            result = await Promise.race([
              promise,
              sleep(grace).then((): never => {
                throw new OrreryError("timeout", "agent did not acknowledge cancellation");
              }),
            ]);
          } else {
            result = await promise;
          }
          await c.drainUpdates();
          return result;
        } catch (err) {
          if (err instanceof JsonRpcError && (err.code === GATEWAY_ERRORS.agentRestarted || err.code === GATEWAY_ERRORS.unknownRequestKey)) {
            const restarted = err.code === GATEWAY_ERRORS.agentRestarted;
            await cb.onEvent({ type: "turn.interrupted", reason: restarted ? "agent process restarted during the turn" : "turn result no longer available on the agent", resumable: restarted });
            throw new OrreryError("interrupted", err.message, { cause: err, retryable: false });
          }
          const transportLost = c.peer.isClosed && !(err instanceof OrreryError);
          if (!transportLost || !deps.viaGateway || attempt >= (deps.maxReconnects ?? 8)) {
            if (transportLost) {
              await cb.onEvent({ type: "turn.interrupted", reason: "lost connection to the agent", resumable: deps.viaGateway });
              throw new OrreryError("interrupted", "lost connection to the agent", { cause: err });
            }
            if (err instanceof JsonRpcError) throw new OrreryError("provider_error", err.message, { cause: err, details: { code: err.code } });
            throw err;
          }
          // Gateway connection dropped: reconnect, re-attach (replay after lastSeq), await the same prompt.
          await sleep(Math.min(10_000, 250 * 2 ** attempt), signal).catch(() => undefined);
          c = await connect();
          client = c;
          const a = await attach(c, sessionId, state.lastSeq);
          if (!a.known || (state.agentEpoch && a.agentEpoch !== state.agentEpoch)) {
            await cb.onEvent({ type: "turn.interrupted", reason: "agent process restarted during the turn", resumable: true });
            throw new OrreryError("interrupted", "agent restarted");
          }
          if (a.pendingPrompt?.requestKey !== input.requestKey && !a.completedKeys.includes(input.requestKey)) {
            await cb.onEvent({ type: "turn.interrupted", reason: "turn result no longer available on the agent", resumable: false });
            throw new OrreryError("interrupted", "prompt result lost");
          }
          promise = awaitPrompt(c, input.requestKey);
          if (cancelSent) c.cancel(sessionId);
        }
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      state.promptInFlight = false;
    }
  }
}
