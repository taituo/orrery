import { createHmac } from "node:crypto";
import type { SessionConfigOption, SessionModeState, SessionModelState } from "./protocol.js";

/**
 * Orrery ACP gateway control protocol.
 *
 * The gateway runs inside each bot computer next to `kiro-cli acp` and relays standard ACP over
 * an authenticated WebSocket. On top of plain ACP it adds a few `_orrery/gateway/*` methods so
 * that a Temporal activity that crashed (or whose pod was rescheduled) can re-attach to a turn
 * that is still running inside Kiro — without resending the prompt, which Kiro explicitly warns
 * against because it can repeat side effects.
 *
 * Every notification the gateway relays carries `params._meta.orrery.seq` (monotonic per
 * session); clients dedupe on it after a re-attach.
 */
export const GATEWAY_METHODS = {
  /** Become the owner of a session; replay journaled notifications with seq > afterSeq. */
  attach: "_orrery/gateway/attach",
  /** Resolve with the `session/prompt` result for `requestKey` (waits if still running). */
  awaitPrompt: "_orrery/gateway/awaitPrompt",
  /** Gateway + agent process status. */
  status: "_orrery/gateway/status",
  /** Stop owning a session (pending agent→client requests are held for the next owner). */
  detach: "_orrery/gateway/detach",
} as const;

export const GATEWAY_TOKEN_AUDIENCE = "orrery-acp-gateway";

/**
 * Per-computer token key, derived from the platform's gateway secret. A computer only ever
 * holds its own key, so an agent that reads its environment can reach nothing but the gateway
 * it already runs behind.
 */
export function gatewayKeyFor(masterSecret: string, computerId: string): string {
  return createHmac("sha256", masterSecret).update(`orrery-gateway-key:${computerId}`).digest("base64url");
}

/** JSON-RPC error codes used by the gateway (server-defined range). */
export const GATEWAY_ERRORS = {
  /** The agent process restarted; in-flight prompts were lost. Resumable by re-prompting manually. */
  agentRestarted: -32098,
  /** No prompt result is known for this request key (gateway restarted or result expired). */
  unknownRequestKey: -32097,
  /** The agent cannot start (e.g. kiro-cli is not signed in, invalid OpenCode config). `data.reason` = AgentFailure code. */
  agentUnavailable: -32096,
} as const;

/** Why the agent process failed to start, derived from its exit and stderr. */
export interface AgentFailure {
  /**
   * agent_auth_required / agent_config_invalid won't fix themselves by restarting the agent;
   * agent_start_failed might (crash, resource pressure).
   */
  code: "agent_auth_required" | "agent_config_invalid" | "agent_start_failed";
  message: string;
  at: string;
}

/** Failures that need an operator; waiting for restarts is pointless. */
export function isPermanentAgentFailure(f: { code?: string } | null | undefined): boolean {
  return f?.code === "agent_auth_required" || f?.code === "agent_config_invalid";
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** Classify an agent that exited before completing `initialize`. */
export function classifyAgentFailure(stderr: string, exit: { code: number | null; signal: string | null }, agent: "kiro" | "opencode" | "acp" = "kiro"): AgentFailure {
  const clean = stderr.replace(ANSI, "");
  const lines = clean.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines.slice(-3).join(" ").slice(0, 500);
  const at = new Date().toISOString();
  // OpenCode validates its configuration (OPENCODE_CONFIG_CONTENT / opencode.json) on start.
  const configLine = lines.findIndex((l) => /configuration is invalid|config file at .* is not valid json|ConfigInvalidError|ConfigJsonError/i.test(l));
  if (configLine >= 0) {
    const detail = lines.slice(configLine, configLine + 4).join(" ").slice(0, 500);
    return { code: "agent_config_invalid", message: `The agent rejected its configuration: ${detail}. Fix the bot's agent settings (OpenCode config) and restart the computer.`, at };
  }
  if (/not logged in|kiro-cli login|log ?in required|authentication required|unauthori[sz]ed|invalid (api )?key|expired (token|credentials)/i.test(clean)) {
    return {
      code: "agent_auth_required",
      message:
        agent === "opencode"
          ? `OpenCode could not authenticate with its model provider (${last || "authentication required"}). Put the provider's API key in the computer's agent secret.`
          : `Kiro is not signed in on this computer (${last || "authentication required"}). Provide a Kiro API key (KIRO_API_KEY, Pro/Pro+/Pro Max/Power plans) or use the client auth method.`,
      at,
    };
  }
  return { code: "agent_start_failed", message: `agent exited during startup (code ${exit.code ?? "–"}${exit.signal ? `, ${exit.signal}` : ""})${last ? `: ${last}` : ""}`, at };
}

export interface AttachParams {
  sessionId: string;
  /** -1 = take ownership without replay. */
  afterSeq: number;
  /** Ask about this prompt (turn) — lets a retried worker discover its prompt is already running. */
  requestKey?: string;
}

export interface AttachResult {
  /** The running agent process knows this session (still in memory). */
  known: boolean;
  /** Random id of the current agent process; changes when the agent restarts. */
  agentEpoch: string;
  lastSeq: number;
  replayed: number;
  /** A prompt for this session that is still running inside the agent. */
  pendingPrompt: { requestKey: string; startedAt: string } | null;
  /** Prompt results held for keys whose requester disconnected. */
  completedKeys: string[];
  /** State of the prompt named in `requestKey` (if any): journal seq when it started, settled or not. */
  prompt?: { requestKey: string; startSeq: number; settled: boolean } | null;
  /** Last advertised modes / models / config options for the session (from new/load + updates). */
  setup: SessionSetupSnapshot | null;
}

export interface SessionSetupSnapshot {
  modes?: SessionModeState | null;
  models?: SessionModelState | null;
  configOptions?: SessionConfigOption[] | null;
}

export interface AwaitPromptParams {
  requestKey: string;
}

export interface GatewayStatus {
  agentEpoch: string;
  agentPid: number | null;
  agentInfo: unknown;
  ready: boolean;
  /** Last startup failure of the agent process (cleared once it initializes). */
  lastError: AgentFailure | null;
  restarts: number;
  startedAt: string;
  sessions: Array<{ sessionId: string; lastSeq: number; owned: boolean; pendingPrompt: string | null; pendingAgentRequests: number }>;
}

export interface OrreryMeta {
  seq?: number;
  requestKey?: string;
  agentEpoch?: string;
}

export function readOrreryMeta(params: unknown): OrreryMeta {
  if (typeof params !== "object" || params === null) return {};
  const meta = (params as { _meta?: { orrery?: OrreryMeta } })._meta;
  return meta?.orrery ?? {};
}

/** Return a shallow copy of params with `_meta.orrery` removed (never forwarded to the agent). */
export function stripOrreryMeta<T>(params: T): T {
  if (typeof params !== "object" || params === null) return params;
  const p = params as { _meta?: Record<string, unknown> };
  if (!p._meta || !("orrery" in p._meta)) return params;
  const { orrery: _o, ...restMeta } = p._meta;
  const copy = { ...(params as object) } as { _meta?: Record<string, unknown> };
  if (Object.keys(restMeta).length) copy._meta = restMeta;
  else delete copy._meta;
  return copy as T;
}

export function withOrreryMeta<T>(params: T, meta: OrreryMeta): T {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return params;
  const p = params as { _meta?: Record<string, unknown> | null };
  const existing = p._meta && typeof p._meta === "object" ? p._meta : {};
  return { ...(params as object), _meta: { ...existing, orrery: { ...((existing as { orrery?: object }).orrery ?? {}), ...meta } } } as T;
}
