import type {
  AgentEvent,
  ConsentContext,
  ContentPart,
  KiroBinding,
  McpAnnotations,
  PermissionOption,
  ToolCallState,
  ToolIdentity,
  ToolRequestFacts,
} from "@orrery/core";
import type { AcpClient } from "../client.js";
import type {
  InitializeRequest,
  InitializeResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  McpServerWire,
  NewSessionRequest,
  NewSessionResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionInfo,
  SessionModeState,
  SessionModelState,
  SessionNotification,
} from "../protocol.js";

export type AdapterName = "kiro-v3" | "kiro-v2" | "opencode" | "acp";

export type AdapterFeature =
  | "loadSession"
  | "resumeSession"
  | "listSessions"
  | "forkSession"
  | "closeSession"
  | "steer"
  | "compact"
  | "setModel"
  | "setEffort"
  | "setMode"
  | "usage"
  | "contextBreakdown"
  | "httpMcp"
  | "sseMcp"
  | "images";

export interface SessionInput {
  cwd: string;
  mcpServers: McpServerWire[];
  additionalDirectories?: string[];
  binding: Partial<Pick<KiroBinding, "modeId" | "modelId" | "effort">>;
}

/** What the agent advertised for a session (captured from new/load responses and updates). */
export interface SessionSetup {
  modes?: SessionModeState | null;
  models?: SessionModelState | null;
  configOptions?: SessionConfigOption[] | null;
}

export interface LaunchInput {
  binary: string;
  binding: Partial<KiroBinding> & { command?: string; args?: string[] };
  env?: Record<string, string>;
  /** Working directory the agent should use (passed as a flag by agents that take one). */
  cwd?: string;
}

export interface LaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** A permission request after adapter-specific parsing — the only shape policy code sees. */
export interface NormalizedPermission {
  sessionId: string;
  toolCall: ToolCallState;
  /** Exactly the options the agent supplied, in order. Never synthesized. */
  options: PermissionOption[];
  consent?: ConsentContext;
  /** Host-resolved identity (Kiro V3 `_meta.kiro.mcpTool.identity` / v2 `mcpToolIdentity`). */
  identity?: ToolIdentity;
  /** Untrusted MCP hints — display only. */
  annotations?: McpAnnotations;
  /** Facts for policy evaluation, derived from agent-supplied consent / raw input. */
  facts: ToolRequestFacts;
  /** Persistent consent is possible (an allow_always option exists and the agent allows persisting). */
  persistable: boolean;
  legacy?: { trustOptions?: unknown[]; fsReadPaths?: unknown };
  raw: RequestPermissionRequest;
}

export type PermissionDecision =
  | { outcome: "cancelled" }
  | { outcome: "selected"; optionId: string; persist?: { scope: "workspace" | "user" | "bot"; resource: string } };

export interface UpdateContext {
  messageId: string;
}

export interface ExtNotificationResult {
  sessionId?: string;
  events: AgentEvent[];
}

export interface AgentAdapter {
  readonly name: AdapterName;
  /** Process launch for a local/gateway-spawned agent. */
  launch(input: LaunchInput): LaunchSpec;
  /** Customize initialize (client capability `_meta`). */
  initializeRequest(base: InitializeRequest): InitializeRequest;
  onInitialized(init: InitializeResponse): void;
  supports(feature: AdapterFeature): boolean;
  newSessionParams(input: SessionInput): NewSessionRequest;
  loadSessionParams(sessionId: string, input: SessionInput): LoadSessionRequest;
  captureSetup(res: NewSessionResponse | LoadSessionResponse): SessionSetup;
  /** Make the session match the binding (model / mode / effort) using only advertised values. */
  configure(client: AcpClient, sessionId: string, setup: SessionSetup, binding: SessionInput["binding"]): Promise<AgentEvent[]>;
  listSessions(client: AcpClient, cwd: string): Promise<SessionInfo[]>;
  /** Inject text into an active turn. Returns false if unsupported. */
  steer(client: AcpClient, sessionId: string, parts: ContentPart[]): Promise<boolean>;
  compact(client: AcpClient, sessionId: string): Promise<boolean>;
  usage(client: AcpClient, sessionId: string): Promise<unknown>;
  normalizeUpdate(notification: SessionNotification, ctx: UpdateContext): AgentEvent[];
  normalizeExtNotification(method: string, params: unknown): ExtNotificationResult | null;
  parsePermission(req: RequestPermissionRequest): NormalizedPermission;
  permissionResponse(perm: NormalizedPermission, decision: PermissionDecision): RequestPermissionResponse;
  /** Agent-specific agent→client requests (return undefined when not handled). */
  handleExtRequest?(method: string, params: unknown, emit: (e: AgentEvent) => void): Promise<unknown> | unknown;
}
