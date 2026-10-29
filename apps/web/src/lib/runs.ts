import { applyToolPatch, mergeUsage, type AgentEvent, type AvailableCommand, type ConfigOption, type ConsentContext, type McpServerStatus, type PermissionOption, type PlanEntry, type RunEventEnvelope, type StopReason, type ToolCallState, type UsageSnapshot } from "@orrery/core/pure";

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "tool"; id: string }
  | { kind: "approval"; id: string }
  | { kind: "steer"; text: string; status: "queued" | "injected" | "cleared" }
  | { kind: "notice"; severity: string; title: string; message?: string }
  | { kind: "auth"; url?: string; message?: string; server?: string }
  | { kind: "delegation"; peerBotId: string; status: string; summary?: string };

export interface ApprovalView {
  approvalId: string;
  toolCall: ToolCallState;
  options: PermissionOption[];
  consent?: ConsentContext;
  policy: { matchedRule?: string; risk?: number; reason?: string };
  expiresAt: string;
  resolved?: { outcome: string; optionKind?: string; decidedBy: string; actor?: string };
}

export interface RunView {
  runId: string;
  botId: string;
  threadId: string;
  startedAt: string;
  lastAt: string;
  provider?: string;
  model?: string;
  engine?: string;
  sessionId?: string;
  route?: { provider: string; model?: string; reason: string; scores?: Record<string, number> };
  recalled: Array<{ id: string; content: string; score: number; kind: string }>;
  knowledge: Array<{ chunkId: string; sourceTitle: string; score: number; excerpt: string }>;
  written: Array<{ id: string; content: string; kind: string; action: string }>;
  segments: Segment[];
  tools: Record<string, ToolCallState>;
  approvals: Record<string, ApprovalView>;
  plan: PlanEntry[];
  usage: UsageSnapshot;
  mcp: McpServerStatus[];
  commands: AvailableCommand[];
  config: ConfigOption[];
  mode?: string;
  subagents: Array<{ sessionId: string; name: string; status: string }>;
  compaction?: { status: string; summary?: string };
  status: "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted";
  stopReason?: StopReason;
  error?: { code: string; message: string };
  eventCount: number;
  unknown: number;
}

export function emptyRun(e: RunEventEnvelope): RunView {
  return { runId: e.runId, botId: e.botId, threadId: e.threadId, startedAt: e.ts, lastAt: e.ts, recalled: [], knowledge: [], written: [], segments: [], tools: {}, approvals: {}, plan: [], usage: {}, mcp: [], commands: [], config: [], subagents: [], status: "running", eventCount: 0, unknown: 0 };
}

const pendingApprovals = (r: RunView) => Object.values(r.approvals).some((a) => !a.resolved);

/** Apply one event to a run view (pure; returns a new object for React). */
export function applyEvent(prev: RunView, env: RunEventEnvelope): RunView {
  const r: RunView = { ...prev, segments: prev.segments.slice(), lastAt: env.ts, eventCount: prev.eventCount + 1 };
  const e: AgentEvent = env.event;
  const lastSeg = r.segments[r.segments.length - 1];
  switch (e.type) {
    case "turn.started":
      r.provider = e.provider;
      if (e.model) r.model = e.model;
      if (e.engine) r.engine = e.engine;
      if (e.sessionId) r.sessionId = e.sessionId;
      break;
    case "route.decided":
      r.route = { provider: e.provider, ...(e.model ? { model: e.model } : {}), reason: e.reason, ...(e.scores ? { scores: e.scores } : {}) };
      break;
    case "memory.recalled":
      r.recalled = e.items;
      break;
    case "knowledge.retrieved":
      r.knowledge = e.items;
      break;
    case "memory.written":
      r.written = [...r.written, ...e.items];
      break;
    case "message.delta":
    case "thought.delta": {
      if (e.replay || e.part.type !== "text") break;
      const kind = e.type === "message.delta" ? "text" : "thought";
      if (lastSeg && lastSeg.kind === kind) r.segments[r.segments.length - 1] = { kind, text: lastSeg.text + e.part.text };
      else r.segments.push({ kind, text: e.part.text });
      break;
    }
    case "tool.preview":
      if (!r.tools[e.toolCallId]) {
        r.tools = { ...r.tools, [e.toolCallId]: { toolCallId: e.toolCallId, title: e.title, kind: e.kind, status: "pending" } };
        r.segments.push({ kind: "tool", id: e.toolCallId });
      }
      break;
    case "tool.call": {
      if (e.replay) break;
      const existing = r.tools[e.call.toolCallId];
      r.tools = { ...r.tools, [e.call.toolCallId]: existing ? applyToolPatch(existing, e.call) : { ...e.call } };
      if (!existing) r.segments.push({ kind: "tool", id: e.call.toolCallId });
      break;
    }
    case "tool.update": {
      if (e.replay) break;
      const t = r.tools[e.toolCallId];
      if (t) r.tools = { ...r.tools, [e.toolCallId]: applyToolPatch(t, e.patch) };
      break;
    }
    case "plan":
      r.plan = e.entries;
      break;
    case "approval.requested":
      r.approvals = { ...r.approvals, [e.approvalId]: { approvalId: e.approvalId, toolCall: e.toolCall, options: e.options, ...(e.consent ? { consent: e.consent } : {}), policy: e.policy, expiresAt: e.expiresAt } };
      // the approval sits next to its tool card when there is one
      if (!r.tools[e.toolCall.toolCallId]) r.segments.push({ kind: "approval", id: e.approvalId });
      else r.segments.splice(r.segments.findIndex((s) => s.kind === "tool" && s.id === e.toolCall.toolCallId) + 1, 0, { kind: "approval", id: e.approvalId });
      r.status = "waiting";
      break;
    case "approval.resolved": {
      const a = r.approvals[e.approvalId];
      if (a) r.approvals = { ...r.approvals, [e.approvalId]: { ...a, resolved: { outcome: e.outcome, ...(e.optionKind ? { optionKind: e.optionKind } : {}), decidedBy: e.decidedBy, ...(e.actor ? { actor: e.actor } : {}) } } };
      if (r.status === "waiting" && !pendingApprovals(r)) r.status = "running";
      break;
    }
    case "usage":
      r.usage = mergeUsage(r.usage, e.usage);
      break;
    case "mcp.status":
      r.mcp = e.servers;
      break;
    case "commands.available":
      r.commands = e.commands;
      break;
    case "config.changed":
      r.config = e.options;
      break;
    case "mode.changed":
      r.mode = e.modeId;
      break;
    case "subagents":
      r.subagents = e.entries;
      break;
    case "compaction":
      r.compaction = { status: e.status, ...(e.summary ? { summary: e.summary } : {}) };
      break;
    case "steering": {
      const idx = r.segments.findIndex((s) => s.kind === "steer" && s.text === e.text && s.status === "queued");
      if (idx >= 0 && e.status !== "queued") r.segments[idx] = { kind: "steer", text: e.text ?? "", status: e.status };
      else if (idx < 0) r.segments.push({ kind: "steer", text: e.text ?? "", status: e.status });
      break;
    }
    case "notice":
      r.segments.push({ kind: "notice", severity: e.severity, title: e.title, ...(e.message ? { message: e.message } : {}) });
      break;
    case "rate_limited":
      r.segments.push({ kind: "notice", severity: "warning", title: "Rate limited", message: e.message });
      break;
    case "auth.required":
      r.segments.push({ kind: "auth", ...(e.url ? { url: e.url } : {}), ...(e.message ? { message: e.message } : {}), ...(e.server ? { server: e.server } : {}) });
      break;
    case "delegation":
      r.segments.push({ kind: "delegation", peerBotId: e.peerBotId, status: e.status, ...(e.summary ? { summary: e.summary } : {}) });
      break;
    case "turn.completed":
      r.status = e.stopReason === "cancelled" ? "cancelled" : "completed";
      r.stopReason = e.stopReason;
      if (e.usage) r.usage = mergeUsage(r.usage, e.usage);
      break;
    case "turn.failed":
      r.status = "failed";
      r.error = { code: e.error.code, message: e.error.message };
      break;
    case "turn.interrupted":
      r.status = "interrupted";
      r.error = { code: "interrupted", message: e.reason };
      break;
    case "unknown_update":
    case "extension":
      r.unknown++;
      break;
    default:
      break;
  }
  return r;
}

export const isActive = (r: RunView) => r.status === "running" || r.status === "waiting";
export const credits = (u: UsageSnapshot) => u.metering?.credits ?? 0;
export const finalText = (r: RunView) => r.segments.filter((s): s is Extract<Segment, { kind: "text" }> => s.kind === "text").map((s) => s.text).join("");
