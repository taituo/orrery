/**
 * Agent Client Protocol (ACP) v1 wire types, written to be *lenient on input*:
 * every object keeps an index signature so unknown fields and `_meta` survive relays and
 * replay unchanged (Kiro V3 requirement), and every discriminated union accepts unknown tags.
 *
 * Source of truth: agentclientprotocol.com schema v1 (validated in tests against the
 * official JSON schema shipped with @agentclientprotocol/sdk) plus Kiro CLI v2/V3 docs.
 */
import type { ContentPart } from "@orrery/core";

export const ACP_PROTOCOL_VERSION = 1;

export type Meta = Record<string, unknown>;
export type Loose<T> = T & { _meta?: Meta | null; [extra: string]: unknown };

export type ContentBlock = ContentPart;

export interface Implementation {
  name: string;
  version: string;
  title?: string | null;
}

export type ClientCapabilities = Loose<{
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  terminal?: boolean;
  elicitation?: { form?: Meta | null; url?: Meta | null } | null;
  session?: Meta | null;
  auth?: { terminal?: boolean };
}>;

export type AgentCapabilities = Loose<{
  loadSession?: boolean;
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
  mcpCapabilities?: { http?: boolean; sse?: boolean; acp?: boolean };
  sessionCapabilities?: Loose<{
    list?: Meta | null;
    delete?: Meta | null;
    additionalDirectories?: Meta | null;
    systemPrompt?: Meta | null;
    fork?: Meta | null;
    resume?: Meta | null;
    close?: Meta | null;
  }>;
}>;

export type AuthMethod = Loose<{ id: string; name: string; description?: string | null; type?: string }>;

export type InitializeRequest = Loose<{
  protocolVersion: number;
  clientCapabilities?: ClientCapabilities;
  clientInfo?: Implementation | null;
}>;

export type InitializeResponse = Loose<{
  protocolVersion: number;
  agentCapabilities?: AgentCapabilities;
  authMethods?: AuthMethod[];
  agentInfo?: Implementation | null;
}>;

export type EnvVariable = { name: string; value: string };
export type HttpHeader = { name: string; value: string };

/** Note: stdio servers carry no `type` on the wire; http/sse do. */
export type McpServerWire =
  | Loose<{ name: string; command: string; args: string[]; env: EnvVariable[] }>
  | Loose<{ type: "http"; name: string; url: string; headers: HttpHeader[] }>
  | Loose<{ type: "sse"; name: string; url: string; headers: HttpHeader[] }>;

export type SessionMode = Loose<{ id: string; name: string; description?: string | null }>;
export type SessionModeState = Loose<{ currentModeId: string; availableModes: SessionMode[] }>;
export type ModelInfo = Loose<{ modelId: string; name: string; description?: string | null }>;
export type SessionModelState = Loose<{ currentModelId: string; availableModels: ModelInfo[] }>;

export type ConfigSelectOption = Loose<{ value: string; name: string; description?: string | null }>;
export type ConfigSelectGroup = Loose<{ group: string; name: string; options: ConfigSelectOption[] }>;
export type SessionConfigOption = Loose<{
  id: string;
  name: string;
  type: "select" | "boolean" | string;
  category?: string | null;
  currentValue?: string | boolean | null;
  options?: Array<ConfigSelectOption | ConfigSelectGroup>;
}>;

export type NewSessionRequest = Loose<{ cwd: string; mcpServers: McpServerWire[]; additionalDirectories?: string[] }>;
export type NewSessionResponse = Loose<{
  sessionId: string;
  modes?: SessionModeState | null;
  models?: SessionModelState | null;
  configOptions?: SessionConfigOption[] | null;
}>;
export type LoadSessionRequest = Loose<{ sessionId: string; cwd: string; mcpServers: McpServerWire[]; additionalDirectories?: string[] }>;
export type LoadSessionResponse = Loose<{ modes?: SessionModeState | null; models?: SessionModelState | null; configOptions?: SessionConfigOption[] | null }>;
export type ListSessionsRequest = Loose<{ cwd?: string | null; cursor?: string | null }>;
export type SessionInfo = Loose<{ sessionId: string; cwd: string; title?: string | null; updatedAt?: string | null; additionalDirectories?: string[] }>;
export type ListSessionsResponse = Loose<{ sessions: SessionInfo[]; nextCursor?: string | null }>;
export type ForkSessionRequest = Loose<{ sessionId: string; cwd: string; mcpServers?: McpServerWire[]; additionalDirectories?: string[] }>;

export type PromptRequest = Loose<{ sessionId: string; prompt: ContentBlock[] }>;
export type StopReasonWire = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";
export type UsageWire = Loose<{
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number | null;
  cachedReadTokens?: number | null;
  cachedWriteTokens?: number | null;
}>;
export type PromptResponse = Loose<{ stopReason: StopReasonWire | string; usage?: UsageWire | null }>;

export type ToolKindWire = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";
export type ToolStatusWire = "pending" | "in_progress" | "completed" | "failed";
export type ToolCallContentWire =
  | Loose<{ type: "content"; content: ContentBlock }>
  | Loose<{ type: "diff"; path: string; newText: string; oldText?: string | null }>
  | Loose<{ type: "terminal"; terminalId: string }>;
export type ToolCallLocationWire = Loose<{ path: string; line?: number | null }>;

export type ToolCallWire = Loose<{
  toolCallId: string;
  title?: string | null;
  name?: string | null;
  kind?: ToolKindWire | string | null;
  status?: ToolStatusWire | string | null;
  content?: ToolCallContentWire[] | null;
  locations?: ToolCallLocationWire[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
}>;

export type PlanEntryWire = Loose<{ content: string; priority: "high" | "medium" | "low"; status: "pending" | "in_progress" | "completed" }>;
export type AvailableCommandWire = Loose<{ name: string; description: string; input?: { hint?: string } | null }>;

/**
 * `session/update` payload. `sessionUpdate` is an open string: known tags are handled,
 * unknown tags are surfaced as `unknown_update` events (never errors).
 */
export type SessionUpdate = Loose<{ sessionUpdate: string }>;
export type SessionNotification = Loose<{ sessionId: string; update: SessionUpdate }>;

export type PermissionOptionWire = Loose<{ optionId: string; name: string; kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string }>;
export type RequestPermissionRequest = Loose<{ sessionId: string; toolCall: ToolCallWire; options: PermissionOptionWire[] }>;
export type RequestPermissionOutcome = { outcome: "cancelled" } | { outcome: "selected"; optionId: string; _meta?: Meta };
export type RequestPermissionResponse = Loose<{ outcome: RequestPermissionOutcome }>;

export type CancelNotification = Loose<{ sessionId: string }>;
export type SetSessionModeRequest = Loose<{ sessionId: string; modeId: string }>;
export type SetSessionConfigOptionRequest = Loose<{ sessionId: string; configId: string; value: string | boolean; type?: "boolean" }>;
export type SetSessionModelRequest = Loose<{ sessionId: string; modelId: string }>;
export type SetSessionConfigOptionResponse = Loose<{ configOptions?: SessionConfigOption[] | null }>;

export type ReadTextFileRequest = Loose<{ sessionId: string; path: string; line?: number | null; limit?: number | null }>;
export type ReadTextFileResponse = Loose<{ content: string }>;
export type WriteTextFileRequest = Loose<{ sessionId: string; path: string; content: string }>;
export type CreateTerminalRequest = Loose<{
  sessionId: string;
  command: string;
  args?: string[];
  cwd?: string | null;
  env?: EnvVariable[];
  outputByteLimit?: number | null;
}>;
export type TerminalRef = Loose<{ sessionId: string; terminalId: string }>;
export type TerminalExitStatus = { exitCode?: number | null; signal?: string | null };
export type TerminalOutputResponse = Loose<{ output: string; truncated: boolean; exitStatus?: TerminalExitStatus | null }>;

export type CreateElicitationRequest = Loose<{
  message: string;
  mode: "form" | "url" | string;
  sessionId?: string;
  requestedSchema?: unknown;
  elicitationId?: string;
  url?: string;
}>;
export type CreateElicitationResponse = Loose<{ action: "accept" | "decline" | "cancel" | string; content?: Record<string, unknown> }>;

/** Standard method names. */
export const METHODS = {
  initialize: "initialize",
  authenticate: "authenticate",
  logout: "logout",
  sessionNew: "session/new",
  sessionLoad: "session/load",
  sessionResume: "session/resume",
  sessionList: "session/list",
  sessionFork: "session/fork",
  sessionClose: "session/close",
  sessionDelete: "session/delete",
  sessionPrompt: "session/prompt",
  sessionCancel: "session/cancel",
  sessionSetMode: "session/set_mode",
  sessionSetConfigOption: "session/set_config_option",
  /** CLI v2 / legacy ACP only. */
  sessionSetModel: "session/set_model",
  sessionUpdate: "session/update",
  sessionRequestPermission: "session/request_permission",
  fsReadTextFile: "fs/read_text_file",
  fsWriteTextFile: "fs/write_text_file",
  terminalCreate: "terminal/create",
  terminalOutput: "terminal/output",
  terminalRelease: "terminal/release",
  terminalWaitForExit: "terminal/wait_for_exit",
  terminalKill: "terminal/kill",
  elicitationCreate: "elicitation/create",
  elicitationComplete: "elicitation/complete",
  cancelRequest: "$/cancel_request",
} as const;

/** MCP server config (Orrery model) → ACP wire format. */
export function toWireMcpServer(s: {
  type: "http" | "sse" | "stdio";
  name: string;
  url?: string;
  headers?: HttpHeader[];
  command?: string;
  args?: string[];
  env?: EnvVariable[];
}): McpServerWire {
  if (s.type === "stdio") return { name: s.name, command: s.command ?? "", args: s.args ?? [], env: s.env ?? [] };
  return { type: s.type, name: s.name, url: s.url ?? "", headers: s.headers ?? [] };
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function getPath(obj: unknown, path: readonly string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (!isRecord(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}
