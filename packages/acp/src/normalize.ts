import type {
  AgentEvent,
  AvailableCommand,
  ConfigOption,
  ContentPart,
  PlanEntry,
  ToolCallState,
  ToolContent,
  ToolKind,
  ToolLocation,
  ToolStatus,
  UsageSnapshot,
} from "@orrery/core";
import { getPath, isRecord, type SessionConfigOption, type SessionUpdate, type UsageWire } from "./protocol.js";

/**
 * Standard ACP `session/update` → normalized events. Adapter-specific enrichment (Kiro `_meta`)
 * is applied by the adapters on top of this.
 */

const TOOL_KINDS = new Set<ToolKind>(["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other"]);
const TOOL_STATUSES = new Set<ToolStatus>(["pending", "in_progress", "completed", "failed"]);

export function toToolKind(v: unknown): ToolKind {
  return typeof v === "string" && TOOL_KINDS.has(v as ToolKind) ? (v as ToolKind) : "other";
}

export function toToolStatus(v: unknown, fallback: ToolStatus = "pending"): ToolStatus {
  return typeof v === "string" && TOOL_STATUSES.has(v as ToolStatus) ? (v as ToolStatus) : fallback;
}

export function toContentPart(v: unknown): ContentPart | null {
  if (!isRecord(v) || typeof v.type !== "string") return null;
  switch (v.type) {
    case "text":
      return typeof v.text === "string" ? (v as ContentPart) : null;
    case "image":
    case "audio":
    case "resource_link":
    case "resource":
      return v as ContentPart;
    default:
      return null; // unknown content block type: callers surface it as `unknown_update`
  }
}

function toToolContent(list: unknown): ToolContent[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const out: ToolContent[] = [];
  for (const c of list) {
    if (!isRecord(c)) continue;
    if (c.type === "content") {
      const part = toContentPart(c.content);
      if (part) out.push({ type: "content", content: part });
    } else if (c.type === "diff" && typeof c.path === "string" && typeof c.newText === "string") {
      out.push({ type: "diff", path: c.path, newText: c.newText, oldText: (c.oldText as string | null | undefined) ?? null });
    } else if (c.type === "terminal" && typeof c.terminalId === "string") {
      out.push({ type: "terminal", terminalId: c.terminalId });
    }
  }
  return out;
}

function toLocations(list: unknown): ToolLocation[] | undefined {
  if (!Array.isArray(list)) return undefined;
  return list.filter(isRecord).filter((l) => typeof l.path === "string").map((l) => ({ path: l.path as string, line: (l.line as number | null | undefined) ?? null }));
}

/** Build a full tool state from a `tool_call` (or a permission request's toolCall). */
export function toolCallFromWire(w: Record<string, unknown>, statusFallback: ToolStatus = "pending"): ToolCallState {
  const title = (typeof w.title === "string" && w.title) || (typeof w.name === "string" && w.name) || "tool";
  const state: ToolCallState = {
    toolCallId: String(w.toolCallId),
    title,
    kind: toToolKind(w.kind),
    status: toToolStatus(w.status, statusFallback),
  };
  if ("rawInput" in w && w.rawInput !== undefined) state.rawInput = w.rawInput;
  if ("rawOutput" in w && w.rawOutput !== undefined) state.rawOutput = w.rawOutput;
  const content = toToolContent(w.content);
  if (content) state.content = content;
  const locations = toLocations(w.locations);
  if (locations) state.locations = locations;
  if (isRecord(w._meta)) state.meta = w._meta;
  return state;
}

/** Build a patch from a `tool_call_update` — absent and null both mean "unchanged". */
export function toolPatchFromWire(w: Record<string, unknown>): Partial<Omit<ToolCallState, "toolCallId">> {
  const patch: Partial<Omit<ToolCallState, "toolCallId">> = {};
  if (typeof w.title === "string") patch.title = w.title;
  else if (typeof w.name === "string") patch.title = w.name;
  if (typeof w.kind === "string") patch.kind = toToolKind(w.kind);
  if (typeof w.status === "string") patch.status = toToolStatus(w.status);
  if (w.rawInput !== undefined && w.rawInput !== null) patch.rawInput = w.rawInput;
  if (w.rawOutput !== undefined && w.rawOutput !== null) patch.rawOutput = w.rawOutput;
  const content = toToolContent(w.content);
  if (content) patch.content = content;
  const locations = toLocations(w.locations);
  if (locations) patch.locations = locations;
  if (isRecord(w._meta)) patch.meta = w._meta;
  return patch;
}

export function toConfigOptions(list: unknown): ConfigOption[] {
  if (!Array.isArray(list)) return [];
  return list.filter(isRecord).map((o) => {
    const opt = o as SessionConfigOption;
    const flat: ConfigOption["options"] = [];
    for (const entry of opt.options ?? []) {
      if (isRecord(entry) && Array.isArray((entry as { options?: unknown }).options)) {
        for (const inner of (entry as { options: Array<Record<string, unknown>> }).options) {
          flat.push({ value: String(inner.value), name: String(inner.name ?? inner.value), description: (inner.description as string | null | undefined) ?? null });
        }
      } else if (isRecord(entry)) {
        flat.push({ value: String(entry.value), name: String(entry.name ?? entry.value), description: (entry.description as string | null | undefined) ?? null });
      }
    }
    return {
      id: String(opt.id),
      name: String(opt.name ?? opt.id),
      type: typeof opt.type === "string" ? opt.type : "select",
      category: (opt.category as string | null | undefined) ?? null,
      currentValue: (opt.currentValue as string | boolean | null | undefined) ?? null,
      options: flat,
      ...(isRecord(opt._meta) ? { meta: opt._meta } : {}),
    };
  });
}

export function usageFromWire(u: UsageWire | null | undefined): UsageSnapshot | undefined {
  if (!u) return undefined;
  const out: UsageSnapshot = {};
  if (typeof u.inputTokens === "number") out.inputTokens = u.inputTokens;
  if (typeof u.outputTokens === "number") out.outputTokens = u.outputTokens;
  if (typeof u.totalTokens === "number") out.totalTokens = u.totalTokens;
  if (typeof u.thoughtTokens === "number") out.thoughtTokens = u.thoughtTokens;
  if (typeof u.cachedReadTokens === "number") out.cachedReadTokens = u.cachedReadTokens;
  if (typeof u.cachedWriteTokens === "number") out.cachedWriteTokens = u.cachedWriteTokens;
  return out;
}

export interface NormalizeContext {
  /** Stable id for the assistant message being streamed in this turn. */
  messageId: string;
  /** Marks the update as part of a load/attach replay. */
  replay?: boolean;
}

/** Normalize a standard ACP session update. Unknown tags become `unknown_update`. */
export function normalizeStandardUpdate(update: SessionUpdate, ctx: NormalizeContext): AgentEvent[] {
  const u = update as Record<string, unknown>;
  const replay = ctx.replay ? { replay: true as const } : {};
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const part = toContentPart(u.content);
      return part ? [{ type: "message.delta", messageId: ctx.messageId, part, ...replay }] : [{ type: "unknown_update", kind: "agent_message_chunk", raw: update }];
    }
    case "agent_thought_chunk": {
      const part = toContentPart(u.content);
      return part ? [{ type: "thought.delta", messageId: ctx.messageId, part, ...replay }] : [{ type: "unknown_update", kind: "agent_thought_chunk", raw: update }];
    }
    case "user_message_chunk": {
      const part = toContentPart(u.content);
      return part ? [{ type: "user.echo", part, ...replay }] : [];
    }
    case "tool_call":
      return [{ type: "tool.call", call: toolCallFromWire(u, "pending"), ...replay }];
    case "tool_call_update":
      return [{ type: "tool.update", toolCallId: String(u.toolCallId), patch: toolPatchFromWire(u), ...replay }];
    case "plan": {
      const entries = Array.isArray(u.entries) ? (u.entries.filter(isRecord) as unknown as PlanEntry[]) : [];
      return [{ type: "plan", entries }];
    }
    case "available_commands_update": {
      const list = Array.isArray(u.availableCommands) ? u.availableCommands.filter(isRecord) : [];
      const commands: AvailableCommand[] = list.map((c) => ({
        name: String(c.name),
        description: String(c.description ?? ""),
        ...(typeof getPath(c, ["input", "hint"]) === "string" ? { inputHint: getPath(c, ["input", "hint"]) as string } : {}),
        ...(isRecord(c._meta) ? { meta: c._meta } : {}),
      }));
      return [{ type: "commands.available", commands }];
    }
    case "current_mode_update":
      return typeof u.currentModeId === "string" ? [{ type: "mode.changed", modeId: u.currentModeId }] : [];
    case "config_option_update":
      return [{ type: "config.changed", options: toConfigOptions(u.configOptions) }];
    case "usage_update": {
      const usage: UsageSnapshot = {};
      if (typeof u.used === "number") usage.contextUsedTokens = u.used;
      if (typeof u.size === "number") usage.contextWindowTokens = u.size;
      if (typeof u.used === "number" && typeof u.size === "number" && u.size > 0) usage.contextPercent = (u.used / u.size) * 100;
      const cost = u.cost;
      if (isRecord(cost) && typeof cost.amount === "number" && (cost.currency === "USD" || cost.currency === "usd")) usage.costUsd = cost.amount;
      return [{ type: "usage", usage }];
    }
    case "notice":
      return [
        {
          type: "notice",
          severity: String(u.severity ?? "info"),
          title: String(u.title ?? "Notice"),
          ...(typeof u.message === "string" ? { message: u.message } : {}),
        },
      ];
    case "compaction_update":
      return [
        {
          type: "compaction",
          status: String(u.status ?? "unknown"),
          ...(typeof u.error === "string" ? { error: u.error } : {}),
        },
      ];
    case "session_info_update":
      // Kiro V3 overloads this via _meta.kiro.kind — adapters refine it. Standard: title/updatedAt.
      return [{ type: "session.info", kind: "session_info", data: stripTag(u) }];
    default:
      return [{ type: "unknown_update", kind: update.sessionUpdate, raw: update }];
  }
}

function stripTag(u: Record<string, unknown>): Record<string, unknown> {
  const { sessionUpdate: _tag, ...rest } = u;
  return rest;
}

/**
 * Pull metering numbers out of an arbitrarily nested Kiro summary structure. Recognizes
 * `{ value, unitPlural | unit }` records (Kiro `meteringUsage`) and sums by unit.
 */
export function collectMetering(value: unknown, into: Record<string, number> = {}, depth = 0): Record<string, number> {
  if (depth > 6) return into;
  if (Array.isArray(value)) {
    for (const v of value) collectMetering(v, into, depth + 1);
    return into;
  }
  if (!isRecord(value)) return into;
  if (typeof value.value === "number" && (typeof value.unitPlural === "string" || typeof value.unit === "string")) {
    const unit = (typeof value.unitPlural === "string" ? value.unitPlural : `${value.unit as string}s`).toLowerCase();
    into[unit] = (into[unit] ?? 0) + value.value;
    return into;
  }
  for (const v of Object.values(value)) collectMetering(v, into, depth + 1);
  return into;
}
