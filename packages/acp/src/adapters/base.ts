import {
  capabilityForKind,
  type AgentEvent,
  type ConsentContext,
  type ContentPart,
  type McpAnnotations,
  type PermissionOption,
  type PermissionOptionKind,
  type ToolIdentity,
} from "@orrery/core";
import type { AcpClient } from "../client.js";
import { JsonRpcError } from "../jsonrpc.js";
import { normalizeStandardUpdate, toolCallFromWire } from "../normalize.js";
import {
  getPath,
  isRecord,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionInfo,
  type SessionNotification,
} from "../protocol.js";
import type {
  AdapterFeature,
  AdapterName,
  AgentAdapter,
  ExtNotificationResult,
  LaunchInput,
  LaunchSpec,
  NormalizedPermission,
  PermissionDecision,
  SessionInput,
  SessionSetup,
  UpdateContext,
} from "./types.js";

const OPTION_KINDS = new Set<PermissionOptionKind>(["allow_once", "allow_always", "reject_once", "reject_always"]);

export function normalizeOptions(raw: unknown): PermissionOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map((o) => ({
    optionId: String(o.optionId),
    name: String(o.name ?? o.optionId),
    // Unknown kinds are treated as one-time rejections for safety in auto-decisions;
    // the original optionId is still what gets returned.
    kind: OPTION_KINDS.has(o.kind as PermissionOptionKind) ? (o.kind as PermissionOptionKind) : "reject_once",
  }));
}

/** Best-effort concrete resource for policy matching, from agent-supplied input only. */
export function resourceFromRawInput(raw: unknown, fallback: string): string {
  if (isRecord(raw)) {
    for (const key of ["command", "cmd", "path", "file_path", "filePath", "filepath", "url", "uri", "pattern", "query"]) {
      const v = raw[key];
      if (typeof v === "string" && v) return v;
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v.join(" ");
    }
  }
  return fallback;
}

/**
 * Standard ACP behaviour. Kiro adapters extend it; generic agents (Gemini CLI, Claude Code
 * ACP, Codex ACP...) use it directly.
 */
export class StandardAcpAdapter implements AgentAdapter {
  readonly name: AdapterName = "acp";
  protected init: InitializeResponse | null = null;

  launch(input: LaunchInput): LaunchSpec {
    return { command: input.binding.command ?? input.binary, args: input.binding.args ?? [], env: input.env ?? {} };
  }

  initializeRequest(base: InitializeRequest): InitializeRequest {
    return base;
  }

  onInitialized(init: InitializeResponse): void {
    this.init = init;
  }

  protected get caps() {
    return this.init?.agentCapabilities ?? {};
  }

  supports(feature: AdapterFeature): boolean {
    const c = this.caps;
    switch (feature) {
      case "loadSession":
        return Boolean(c.loadSession);
      case "resumeSession":
        return Boolean(c.sessionCapabilities?.resume);
      case "listSessions":
        return Boolean(c.sessionCapabilities?.list);
      case "forkSession":
        return Boolean(c.sessionCapabilities?.fork);
      case "closeSession":
        return Boolean(c.sessionCapabilities?.close);
      case "httpMcp":
        return Boolean(c.mcpCapabilities?.http);
      case "sseMcp":
        return Boolean(c.mcpCapabilities?.sse);
      case "images":
        return Boolean(c.promptCapabilities?.image);
      case "setMode":
        return true;
      case "setModel":
      case "setEffort":
        return true; // via advertised config options when present
      case "steer":
        return Boolean(getPath(this.init, ["_meta", "steering", "supported"]));
      default:
        return false;
    }
  }

  newSessionParams(input: SessionInput): NewSessionRequest {
    return {
      cwd: input.cwd,
      mcpServers: this.filterMcp(input.mcpServers),
      ...(input.additionalDirectories?.length && this.caps.sessionCapabilities?.additionalDirectories ? { additionalDirectories: input.additionalDirectories } : {}),
    };
  }

  loadSessionParams(sessionId: string, input: SessionInput): LoadSessionRequest {
    return { sessionId, ...this.newSessionParams(input) };
  }

  /** Drop server types the agent cannot use (it would reject the whole session otherwise). */
  protected filterMcp(servers: SessionInput["mcpServers"]): SessionInput["mcpServers"] {
    return servers.filter((s) => {
      const t = (s as { type?: string }).type;
      if (t === "http") return this.supports("httpMcp");
      if (t === "sse") return this.supports("sseMcp");
      return true;
    });
  }

  captureSetup(res: NewSessionResponse | LoadSessionResponse): SessionSetup {
    return { modes: res.modes ?? null, models: (res as NewSessionResponse).models ?? null, configOptions: res.configOptions ?? null };
  }

  async configure(client: AcpClient, sessionId: string, setup: SessionSetup, binding: SessionInput["binding"]): Promise<AgentEvent[]> {
    const notices: AgentEvent[] = [];
    if (binding.modelId) notices.push(...(await this.applyConfigOption(client, sessionId, setup, ["model"], binding.modelId)));
    if (binding.effort) notices.push(...(await this.applyConfigOption(client, sessionId, setup, ["effortLevel", "effort", "reasoning_effort"], binding.effort)));
    if (binding.modeId) notices.push(...(await this.applyMode(client, sessionId, setup, binding.modeId)));
    return notices;
  }

  protected async applyConfigOption(
    client: AcpClient,
    sessionId: string,
    setup: SessionSetup,
    ids: string[],
    value: string,
  ): Promise<AgentEvent[]> {
    const opt = setup.configOptions?.find((o) => ids.includes(o.id));
    if (!opt) return [{ type: "notice", severity: "warning", title: `Agent does not advertise ${ids[0]}; keeping its default` }];
    if (opt.currentValue === value) return [];
    const advertised = flattenValues(opt.options);
    if (advertised.length && !advertised.includes(value)) {
      return [{ type: "notice", severity: "warning", title: `${ids[0]} "${value}" is not offered by this agent`, message: `Available: ${advertised.join(", ")}` }];
    }
    const res = await client.setConfigOption(sessionId, opt.id, value);
    if (Array.isArray(res?.configOptions)) setup.configOptions = res.configOptions;
    else opt.currentValue = value;
    return [];
  }

  protected async applyMode(client: AcpClient, sessionId: string, setup: SessionSetup, modeId: string): Promise<AgentEvent[]> {
    const modeOpt = setup.configOptions?.find((o) => o.id === "mode");
    if (modeOpt) return this.applyConfigOption(client, sessionId, setup, ["mode"], modeId);
    if (!setup.modes) return [{ type: "notice", severity: "warning", title: "Agent does not advertise modes" }];
    if (setup.modes.currentModeId === modeId) return [];
    if (!setup.modes.availableModes.some((m) => m.id === modeId)) {
      return [{ type: "notice", severity: "warning", title: `Mode "${modeId}" is not offered`, message: setup.modes.availableModes.map((m) => m.id).join(", ") }];
    }
    await client.setMode(sessionId, modeId);
    setup.modes.currentModeId = modeId;
    return [];
  }

  async listSessions(client: AcpClient, cwd: string): Promise<SessionInfo[]> {
    if (!this.supports("listSessions")) return [];
    const out: SessionInfo[] = [];
    let cursor: string | null | undefined = undefined;
    for (let page = 0; page < 50; page++) {
      const res = await client.listSessions({ cwd, ...(cursor ? { cursor } : {}) });
      out.push(...(res.sessions ?? []));
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  async steer(client: AcpClient, sessionId: string, parts: ContentPart[]): Promise<boolean> {
    if (!this.supports("steer")) return false;
    await client.ext("_session/steering", { sessionId, prompt: parts });
    return true;
  }

  async compact(_client: AcpClient, _sessionId: string): Promise<boolean> {
    return false;
  }

  async usage(_client: AcpClient, _sessionId: string): Promise<unknown> {
    return null;
  }

  protected isReplay(_n: SessionNotification): boolean {
    return false;
  }

  normalizeUpdate(n: SessionNotification, ctx: UpdateContext): AgentEvent[] {
    if (!isRecord(n.update) || typeof n.update.sessionUpdate !== "string") {
      return [{ type: "unknown_update", kind: "malformed", raw: n }];
    }
    return normalizeStandardUpdate(n.update, { messageId: ctx.messageId, replay: this.isReplay(n) });
  }

  normalizeExtNotification(method: string, params: unknown): ExtNotificationResult | null {
    const sessionId = isRecord(params) && typeof params.sessionId === "string" ? params.sessionId : undefined;
    return { ...(sessionId ? { sessionId } : {}), events: [{ type: "extension", method, params }] };
  }

  /** Identity and hints; overridden by Kiro adapters. */
  protected identityOf(_req: RequestPermissionRequest): { identity?: ToolIdentity; annotations?: McpAnnotations } {
    return {};
  }

  protected consentOf(_req: RequestPermissionRequest): ConsentContext | undefined {
    return undefined;
  }

  parsePermission(req: RequestPermissionRequest): NormalizedPermission {
    const toolCall = toolCallFromWire(isRecord(req.toolCall) ? req.toolCall : { toolCallId: "unknown" }, "pending");
    const options = normalizeOptions(req.options);
    const consent = this.consentOf(req);
    const { identity, annotations } = this.identityOf(req);
    const isMcp = identity?.source === "mcp";
    const capability = consent?.capability ?? (isMcp ? "mcp" : capabilityForKind(toolCall.kind));
    const resource =
      consent?.resource ??
      (isMcp && identity?.server && identity.tool ? `${identity.server}/${identity.tool}` : resourceFromRawInput(toolCall.rawInput, toolCall.title));
    return {
      sessionId: req.sessionId,
      toolCall: { ...toolCall, ...(identity ? { identity } : {}), ...(annotations ? { annotations } : {}) },
      options,
      ...(consent ? { consent } : {}),
      ...(identity ? { identity } : {}),
      ...(annotations ? { annotations } : {}),
      facts: {
        capability,
        kind: toolCall.kind,
        resource,
        ...(identity?.server ? { mcpServer: identity.server } : {}),
        ...(identity?.tool ? { tool: identity.tool } : {}),
      },
      persistable: options.some((o) => o.kind === "allow_always") && consent?.persistableConsent !== false,
      raw: req,
    };
  }

  permissionResponse(perm: NormalizedPermission, decision: PermissionDecision): RequestPermissionResponse {
    if (decision.outcome === "cancelled") return { outcome: { outcome: "cancelled" } };
    if (!perm.options.some((o) => o.optionId === decision.optionId)) {
      // Never invent options: the agent only honours ids it offered.
      throw new JsonRpcError(-32602, `option ${decision.optionId} was not offered by the agent`);
    }
    return { outcome: { outcome: "selected", optionId: decision.optionId } };
  }
}

export function flattenValues(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  const out: string[] = [];
  for (const o of options) {
    if (!isRecord(o)) continue;
    if (Array.isArray(o.options)) out.push(...flattenValues(o.options));
    else if (o.value !== undefined) out.push(String(o.value));
  }
  return out;
}
