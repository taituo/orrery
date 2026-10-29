import type { ContentPart } from "./content.js";

/**
 * Normalized agent event stream.
 *
 * Every provider (Kiro CLI V3, Kiro CLI v2, generic ACP agents, OpenAI-compatible tool loops)
 * is translated into this one vocabulary. The UI, persistence, Langfuse tracing and memory
 * extraction only ever consume these events. Anything a provider sends that we do not
 * understand is preserved verbatim as `extension` / `unknown_update` so nothing is lost and a
 * newer agent never breaks an older platform build (ACP rule: unknown updates must not fail
 * the session).
 */

export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";

export interface ToolLocation {
  path: string;
  line?: number | null;
}

export type ToolContent =
  | { type: "content"; content: ContentPart }
  | { type: "diff"; path: string; newText: string; oldText?: string | null }
  | { type: "terminal"; terminalId: string };

/** Host-resolved identity of a tool. Display only — never used to authorize. */
export interface ToolIdentity {
  source: "builtin" | "mcp" | "platform" | "unknown";
  server?: string;
  tool?: string;
}

/** MCP behaviour hints. Untrusted claims: display only, never used to approve or lower risk. */
export interface McpAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolCallState {
  toolCallId: string;
  title: string;
  kind: ToolKind;
  status: ToolStatus;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: ToolContent[];
  locations?: ToolLocation[];
  identity?: ToolIdentity;
  annotations?: McpAnnotations;
  failureReason?: "cancelled" | "denied" | "error" | "unknown";
  meta?: Record<string, unknown>;
}

export type PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}

/** Kiro V3 consent context (`_meta.kiro.consent`) — also synthesized for other agents. */
export interface ConsentContext {
  capability?: string;
  resource?: string;
  triggeringResource?: string;
  workspaceRoot?: string;
  persistableConsent?: boolean;
}

export interface PlanEntry {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}

export interface AvailableCommand {
  name: string;
  description: string;
  inputHint?: string;
  meta?: Record<string, unknown>;
}

export interface ConfigOptionValue {
  value: string;
  name: string;
  description?: string | null;
}

export interface ConfigOption {
  id: string;
  name: string;
  type: "select" | "boolean" | string;
  category?: string | null;
  currentValue?: string | boolean | null;
  options?: ConfigOptionValue[];
  meta?: Record<string, unknown>;
}

export interface McpServerStatus {
  name: string;
  state: "connected" | "failed" | "disabled" | "pending" | string;
  error?: string;
  failedAuthorization?: boolean;
  toolCount?: number;
}

export interface UsageSnapshot {
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  totalTokens?: number;
  /** Provider metering, e.g. Kiro credits: `{ credits: 0.018 }` */
  metering?: Record<string, number>;
  contextUsedTokens?: number;
  contextWindowTokens?: number;
  contextPercent?: number;
  costUsd?: number;
  turnDurationMs?: number;
}

export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

export type AgentEvent =
  | { type: "turn.started"; provider: string; model?: string; sessionId?: string; engine?: string }
  | { type: "route.decided"; provider: string; model?: string; reason: string; scores?: Record<string, number> }
  | { type: "memory.recalled"; items: Array<{ id: string; content: string; score: number; kind: string }> }
  | { type: "knowledge.retrieved"; items: Array<{ chunkId: string; sourceTitle: string; score: number; excerpt: string }> }
  | { type: "message.delta"; messageId: string; part: ContentPart; replay?: boolean }
  | { type: "thought.delta"; messageId: string; part: ContentPart; replay?: boolean }
  | { type: "user.echo"; part: ContentPart; replay?: boolean }
  | { type: "tool.preview"; toolCallId: string; title: string; kind: ToolKind }
  | { type: "tool.call"; call: ToolCallState; replay?: boolean }
  | { type: "tool.update"; toolCallId: string; patch: Partial<Omit<ToolCallState, "toolCallId">>; replay?: boolean }
  | { type: "plan"; entries: PlanEntry[] }
  | {
      type: "approval.requested";
      approvalId: string;
      toolCall: ToolCallState;
      options: PermissionOption[];
      consent?: ConsentContext;
      policy: { action: "ask"; matchedRule?: string; risk?: number; reason?: string };
      expiresAt: string;
    }
  | {
      type: "approval.resolved";
      approvalId: string;
      outcome: "selected" | "cancelled" | "expired";
      optionId?: string;
      optionKind?: PermissionOptionKind;
      decidedBy: "user" | "policy" | "guardrail" | "timeout" | "system";
      actor?: string;
      reason?: string;
    }
  | { type: "commands.available"; commands: AvailableCommand[] }
  | { type: "mode.changed"; modeId: string }
  | { type: "config.changed"; options: ConfigOption[] }
  | { type: "usage"; usage: UsageSnapshot }
  | { type: "session.info"; kind: string; data: Record<string, unknown> }
  | { type: "notice"; severity: "info" | "warning" | "error" | string; title: string; message?: string }
  | { type: "compaction"; status: string; summary?: string; error?: string }
  | { type: "mcp.status"; servers: McpServerStatus[] }
  | { type: "tools.changed"; tools: Array<{ name: string; description?: string; source?: string }> }
  | { type: "auth.required"; kind: "mcp_oauth" | "agent_login" | "elicitation_url"; url?: string; server?: string; message?: string }
  | { type: "elicitation.requested"; elicitationId: string; message: string; mode: string; schema?: unknown; url?: string }
  | { type: "rate_limited"; message: string }
  | { type: "subagents"; entries: Array<{ sessionId: string; name: string; status: string; group?: string; role?: string }> }
  | { type: "steering"; status: "queued" | "injected" | "cleared"; text?: string }
  | { type: "delegation"; direction: "outbound" | "inbound"; peerBotId: string; status: "requested" | "completed" | "failed"; summary?: string }
  | { type: "memory.written"; items: Array<{ id: string; content: string; kind: string; action: "created" | "updated" | "superseded" }> }
  | { type: "turn.completed"; stopReason: StopReason; usage?: UsageSnapshot; refusal?: boolean }
  | { type: "turn.failed"; error: { code: string; message: string; retryable: boolean } }
  | { type: "turn.interrupted"; reason: string; resumable: boolean }
  | { type: "extension"; method: string; params: unknown }
  | { type: "unknown_update"; kind: string; raw: unknown };

export type AgentEventType = AgentEvent["type"];

/** Persisted envelope for one event in a run's ordered stream. */
export interface RunEventEnvelope {
  id: string;
  runId: string;
  threadId: string;
  botId: string;
  seq: number;
  ts: string;
  event: AgentEvent;
}

/** Events that represent a final state of a turn. */
export function isTerminalEvent(e: AgentEvent): boolean {
  return e.type === "turn.completed" || e.type === "turn.failed" || e.type === "turn.interrupted";
}

/** Merge a tool update patch into accumulated tool state (null/absent means "no change"). */
export function applyToolPatch(state: ToolCallState, patch: Partial<Omit<ToolCallState, "toolCallId">>): ToolCallState {
  const next: ToolCallState = { ...state };
  for (const [k, v] of Object.entries(patch) as Array<[keyof ToolCallState, unknown]>) {
    if (v === undefined || v === null) continue;
    (next as unknown as Record<string, unknown>)[k] = v;
  }
  return next;
}

/**
 * Fold an event stream into a compact transcript (used by finalize, memory extraction and
 * thread replay). Keeps the last state of each tool call by id, in first-seen order.
 */
export interface TurnTranscript {
  assistantText: string;
  thoughtText: string;
  tools: ToolCallState[];
  plan: PlanEntry[];
  usage: UsageSnapshot;
  stopReason?: StopReason;
  failed?: { code: string; message: string };
}

export function foldTranscript(events: Iterable<AgentEvent>): TurnTranscript {
  const t: TurnTranscript = { assistantText: "", thoughtText: "", tools: [], plan: [], usage: {} };
  const toolIndex = new Map<string, number>();
  for (const e of events) {
    switch (e.type) {
      case "message.delta":
        if (!e.replay && e.part.type === "text") t.assistantText += e.part.text;
        break;
      case "thought.delta":
        if (!e.replay && e.part.type === "text") t.thoughtText += e.part.text;
        break;
      case "tool.call": {
        if (e.replay) break;
        const idx = toolIndex.get(e.call.toolCallId);
        if (idx === undefined) {
          toolIndex.set(e.call.toolCallId, t.tools.length);
          t.tools.push({ ...e.call });
        } else {
          t.tools[idx] = applyToolPatch(t.tools[idx]!, e.call);
        }
        break;
      }
      case "tool.update": {
        if (e.replay) break;
        const idx = toolIndex.get(e.toolCallId);
        if (idx !== undefined) t.tools[idx] = applyToolPatch(t.tools[idx]!, e.patch);
        break;
      }
      case "plan":
        t.plan = e.entries;
        break;
      case "usage":
        t.usage = mergeUsage(t.usage, e.usage);
        break;
      case "turn.completed":
        t.stopReason = e.stopReason;
        if (e.usage) t.usage = mergeUsage(t.usage, e.usage);
        break;
      case "turn.failed":
        t.failed = { code: e.error.code, message: e.error.message };
        break;
      default:
        break;
    }
  }
  return t;
}

export function mergeUsage(a: UsageSnapshot, b: UsageSnapshot): UsageSnapshot {
  const out: UsageSnapshot = { ...a };
  for (const [k, v] of Object.entries(b) as Array<[keyof UsageSnapshot, unknown]>) {
    if (v === undefined || v === null) continue;
    if (k === "metering" && typeof v === "object") {
      const m = { ...(out.metering ?? {}) };
      for (const [mk, mv] of Object.entries(v as Record<string, number>)) m[mk] = (m[mk] ?? 0) + mv;
      out.metering = m;
    } else {
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}
