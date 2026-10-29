import type { AgentEvent, ConsentContext, ContentPart, McpAnnotations, McpServerStatus, ToolIdentity } from "@orrery/core";
import type { AcpClient } from "../client.js";
import { collectMetering } from "../normalize.js";
import {
  getPath,
  isRecord,
  type InitializeRequest,
  type NewSessionRequest,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "../protocol.js";
import { StandardAcpAdapter } from "./base.js";
import type {
  AdapterFeature,
  AdapterName,
  ExtNotificationResult,
  LaunchInput,
  LaunchSpec,
  NormalizedPermission,
  PermissionDecision,
  SessionInput,
  SessionSetup,
  UpdateContext,
} from "./types.js";

/**
 * Kiro CLI V3 (`kiro-cli acp --agent-engine=v3`).
 *
 * Implements https://kiro.dev/docs/cli/v3/acp-migration/ :
 *  - capability negotiation: optional methods only when listed in
 *    `agentCapabilities._meta.kiro.extensionMethods` (the running server is authoritative)
 *  - model/effort via `session/set_config_option` (`model`, `effortLevel`), mode via set_mode
 *  - initial mode/model/effort under `_meta.kiro` on session/new and session/load
 *  - client-owned inputs (cwd, additionalDirectories, mcpServers) re-sent on session/load
 *  - `session_info_update` dispatched by `_meta.kiro.kind`
 *  - replay marking `_meta.kiro.replay`, failure reasons `_meta.kiro.failureReason`
 *  - permissions: standard options[] + `_meta.kiro.consent`; persistent choices return canonical
 *    consent metadata; MCP identity from `_meta.kiro.mcpTool` (v1); annotations untrusted
 *  - `_kiro/mcp/status` snapshots, `_kiro/tools/didChange`, `_kiro/openExternalUrl`,
 *    `_kiro/auth/getAccessToken` (when launched with --auth-method=client)
 *  - turns settle from the `session/prompt` response only (no TurnEnd discriminator)
 */
export class KiroV3Adapter extends StandardAcpAdapter {
  override readonly name: AdapterName = "kiro-v3";
  private extMethods = new Set<string>();

  constructor(
    private readonly opts: {
      /** Supplies access tokens when launched with --auth-method=client. Never logged. */
      accessToken?: () => Promise<unknown>;
    } = {},
  ) {
    super();
  }

  override launch(input: LaunchInput): LaunchSpec {
    // V3 rejects --agent/--model/--effort/--trust-* on `acp`; those are session inputs now.
    const args = ["acp", "--agent-engine=v3"];
    if (input.binding.authMethod === "client") args.push("--auth-method=client");
    return { command: input.binary, args, env: input.env ?? {} };
  }

  override initializeRequest(base: InitializeRequest): InitializeRequest {
    const caps = base.clientCapabilities ?? {};
    const meta = isRecord(caps._meta) ? caps._meta : {};
    const kiro = isRecord(meta.kiro) ? meta.kiro : {};
    return { ...base, clientCapabilities: { ...caps, _meta: { ...meta, kiro: { ...kiro, openExternalUrl: true } } } };
  }

  override onInitialized(init: Parameters<StandardAcpAdapter["onInitialized"]>[0]): void {
    super.onInitialized(init);
    const list = getPath(init, ["agentCapabilities", "_meta", "kiro", "extensionMethods"]);
    this.extMethods = new Set(Array.isArray(list) ? list.filter((m): m is string => typeof m === "string") : []);
  }

  /** Is an optional Kiro extension advertised by the running server? */
  hasExt(method: string): boolean {
    return this.extMethods.has(method) || this.extMethods.has(method.replace(/^_/, ""));
  }

  get advertisedExtensions(): string[] {
    return [...this.extMethods];
  }

  override supports(feature: AdapterFeature): boolean {
    switch (feature) {
      case "listSessions":
        return Boolean(this.caps.sessionCapabilities?.list) || this.init !== null; // V3 implements session/list
      case "forkSession":
        return Boolean(this.caps.sessionCapabilities?.fork) || this.init !== null;
      case "steer":
        return this.hasExt("_session/steer");
      case "compact":
        return this.hasExt("_kiro/session/compact");
      case "usage":
        return this.hasExt("_kiro/account/getUsage");
      case "contextBreakdown":
        return this.hasExt("_kiro/session/context");
      case "setModel":
      case "setEffort":
        return true;
      default:
        return super.supports(feature);
    }
  }

  override newSessionParams(input: SessionInput): NewSessionRequest {
    const kiro: Record<string, string> = {};
    if (input.binding.modeId) kiro.modeId = input.binding.modeId;
    if (input.binding.modelId) kiro.modelId = input.binding.modelId;
    if (input.binding.effort) kiro.effortLevel = input.binding.effort;
    return {
      cwd: input.cwd,
      mcpServers: this.filterMcp(input.mcpServers),
      ...(input.additionalDirectories?.length ? { additionalDirectories: input.additionalDirectories } : {}),
      ...(Object.keys(kiro).length ? { _meta: { kiro } } : {}),
    };
  }

  override async configure(client: AcpClient, sessionId: string, setup: SessionSetup, binding: SessionInput["binding"]): Promise<AgentEvent[]> {
    const notices: AgentEvent[] = [];
    // Only touch values the server advertises; never reuse values cached from another deployment.
    if (binding.modelId) notices.push(...(await this.applyConfigOption(client, sessionId, setup, ["model"], binding.modelId)));
    if (binding.effort) notices.push(...(await this.applyConfigOption(client, sessionId, setup, ["effortLevel"], binding.effort)));
    if (binding.modeId) notices.push(...(await this.applyMode(client, sessionId, setup, binding.modeId)));
    return notices;
  }

  override async steer(client: AcpClient, sessionId: string, parts: ContentPart[]): Promise<boolean> {
    // `_session/steer` intentionally keeps its `_session/` name in V3.
    if (!this.hasExt("_session/steer")) return false;
    await client.ext("_session/steer", { sessionId, prompt: parts });
    return true;
  }

  override async compact(client: AcpClient, sessionId: string): Promise<boolean> {
    if (!this.hasExt("_kiro/session/compact")) return false;
    await client.ext("_kiro/session/compact", { sessionId }, 600_000);
    return true;
  }

  override async usage(client: AcpClient, _sessionId: string): Promise<unknown> {
    if (!this.hasExt("_kiro/account/getUsage")) return null;
    return client.ext("_kiro/account/getUsage", {});
  }

  async contextBreakdown(client: AcpClient, sessionId: string): Promise<unknown> {
    if (!this.hasExt("_kiro/session/context")) return null;
    return client.ext("_kiro/session/context", { sessionId });
  }

  protected override isReplay(n: SessionNotification): boolean {
    return getPath(n.update, ["_meta", "kiro", "replay"]) === true;
  }

  override normalizeUpdate(n: SessionNotification, ctx: UpdateContext): AgentEvent[] {
    const u = n.update as Record<string, unknown>;
    if (u.sessionUpdate === "session_info_update") return this.sessionInfo(u);
    const events = super.normalizeUpdate(n, ctx);
    // Enrich tool events with Kiro metadata.
    for (const e of events) {
      if (e.type === "tool.update") {
        const reason = getPath(u, ["_meta", "kiro", "failureReason"]);
        if (typeof reason === "string") {
          e.patch.failureReason = reason === "cancelled" || reason === "denied" || reason === "error" ? reason : "unknown";
        }
        const ident = this.mcpToolEnvelope(u._meta);
        if (ident.identity) e.patch.identity = ident.identity;
        if (ident.annotations) e.patch.annotations = ident.annotations;
      } else if (e.type === "tool.call") {
        const ident = this.mcpToolEnvelope(u._meta);
        if (ident.identity) e.call.identity = ident.identity;
        if (ident.annotations) e.call.annotations = ident.annotations;
      }
    }
    return events;
  }

  private sessionInfo(u: Record<string, unknown>): AgentEvent[] {
    const kiro = getPath(u, ["_meta", "kiro"]);
    const kind = isRecord(kiro) && typeof kiro.kind === "string" ? kiro.kind : "session_info";
    const data = isRecord(kiro) ? { ...kiro } : {};
    if (typeof u.title === "string") data.title = u.title;
    if (typeof u.updatedAt === "string") data.updatedAt = u.updatedAt;
    switch (kind) {
      case "context_usage": {
        const pct = (data.usagePercentage ?? data.usagePercent ?? data.percentage) as unknown;
        return typeof pct === "number" ? [{ type: "usage", usage: { contextPercent: pct } }] : [{ type: "session.info", kind, data }];
      }
      case "turn_completion": {
        const metering = collectMetering(data.promptTurnSummaries ?? data);
        const elapsed = (data.elapsedMs ?? data.elapsedTimeMs ?? data.durationMs ?? data.turnDurationMs) as unknown;
        return [
          {
            type: "usage",
            usage: {
              ...(Object.keys(metering).length ? { metering } : {}),
              ...(typeof elapsed === "number" ? { turnDurationMs: elapsed } : {}),
            },
          },
          { type: "session.info", kind, data },
        ];
      }
      case "steering_queued":
        return [{ type: "steering", status: "queued", ...(typeof data.text === "string" ? { text: data.text } : {}) }];
      case "steering_injected":
        return [{ type: "steering", status: "injected", ...(typeof data.text === "string" ? { text: data.text } : {}) }];
      case "steering_cleared":
        return [{ type: "steering", status: "cleared" }];
      default:
        if (kind.startsWith("summariz") || kind.startsWith("compact")) {
          return [{ type: "compaction", status: String(data.status ?? kind), ...(typeof data.summary === "string" ? { summary: data.summary } : {}) }];
        }
        // turn_end (not a completion signal), lifecycle states, etc.
        return [{ type: "session.info", kind, data }];
    }
  }

  private mcpToolEnvelope(meta: unknown): { identity?: ToolIdentity; annotations?: McpAnnotations } {
    const env = getPath(meta, ["kiro", "mcpTool"]);
    if (!isRecord(env)) return {};
    // Only version 1 is understood; newer envelopes are ignored rather than misread.
    if (env.version !== undefined && env.version !== 1) return {};
    const out: { identity?: ToolIdentity; annotations?: McpAnnotations } = {};
    if (isRecord(env.identity)) {
      out.identity = {
        source: "mcp",
        ...(typeof env.identity.serverName === "string" ? { server: env.identity.serverName } : {}),
        ...(typeof env.identity.toolName === "string" ? { tool: env.identity.toolName } : {}),
      };
    }
    if (isRecord(env.annotations)) out.annotations = pickAnnotations(env.annotations);
    return out;
  }

  protected override identityOf(req: RequestPermissionRequest): { identity?: ToolIdentity; annotations?: McpAnnotations } {
    const fromReq = this.mcpToolEnvelope(req._meta);
    if (fromReq.identity || fromReq.annotations) return fromReq;
    return this.mcpToolEnvelope(isRecord(req.toolCall) ? req.toolCall._meta : undefined);
  }

  protected override consentOf(req: RequestPermissionRequest): ConsentContext | undefined {
    const c = getPath(req, ["_meta", "kiro", "consent"]);
    if (!isRecord(c)) return undefined;
    const out: ConsentContext = {};
    if (typeof c.capability === "string") out.capability = c.capability;
    if (typeof c.resource === "string") out.resource = c.resource;
    if (typeof c.triggeringResource === "string") out.triggeringResource = c.triggeringResource;
    if (typeof c.workspaceRoot === "string") out.workspaceRoot = c.workspaceRoot;
    if (typeof c.persistableConsent === "boolean") out.persistableConsent = c.persistableConsent;
    return out;
  }

  override permissionResponse(perm: NormalizedPermission, decision: PermissionDecision): RequestPermissionResponse {
    const base = super.permissionResponse(perm, decision);
    if (decision.outcome !== "selected" || !decision.persist) return base;
    const option = perm.options.find((o) => o.optionId === decision.optionId);
    const persistent = option?.kind === "allow_always" || option?.kind === "reject_always";
    if (!persistent || perm.consent?.persistableConsent === false) return base;
    // Canonical consent: scope + resource pattern + workspace root, alongside the original optionId.
    return {
      ...base,
      _meta: {
        kiro: {
          consent: {
            scope: decision.persist.scope === "bot" ? "workspace" : decision.persist.scope,
            resource: decision.persist.resource,
            ...(perm.consent?.workspaceRoot ? { workspaceRoot: perm.consent.workspaceRoot } : {}),
          },
        },
      },
    };
  }

  override normalizeExtNotification(method: string, params: unknown): ExtNotificationResult | null {
    const p = isRecord(params) ? params : {};
    const sessionId = typeof p.sessionId === "string" ? p.sessionId : undefined;
    const withSession = (events: AgentEvent[]): ExtNotificationResult => ({ ...(sessionId ? { sessionId } : {}), events });
    switch (method) {
      case "_kiro/mcp/status":
        return withSession([{ type: "mcp.status", servers: parseMcpSnapshot(p) }]);
      case "_kiro/tools/didChange": {
        const tools = Array.isArray(p.tools) ? p.tools.filter(isRecord) : [];
        return withSession([
          {
            type: "tools.changed",
            tools: tools.map((t) => ({
              name: String(t.name ?? t.toolName ?? "tool"),
              ...(typeof t.description === "string" ? { description: t.description } : {}),
              ...(typeof t.source === "string" ? { source: t.source } : {}),
            })),
          },
        ]);
      }
      case "_kiro/error/rate_limit":
        return withSession([{ type: "rate_limited", message: String(p.message ?? "Rate limited") }]);
      case "_kiro/customAgent/not_found":
        return withSession([{ type: "notice", severity: "warning", title: "Custom agent not found", message: JSON.stringify(p) }]);
      case "_kiro/customAgent/config_error":
        return withSession([{ type: "notice", severity: "error", title: "Custom agent configuration error", message: JSON.stringify(p) }]);
      case "_kiro/mcp/governance_disabled":
        return withSession([{ type: "notice", severity: "warning", title: "MCP disabled by governance", message: JSON.stringify(p) }]);
      case "_kiro/governance/state":
        return withSession([{ type: "session.info", kind: "governance_state", data: p }]);
      default:
        if (method.startsWith("_kiro/workflow/")) return withSession([{ type: "session.info", kind: method.slice("_kiro/".length), data: p }]);
        return withSession([{ type: "extension", method, params }]);
    }
  }

  async handleExtRequest(method: string, params: unknown, emit: (e: AgentEvent) => void): Promise<unknown> {
    switch (method) {
      case "_kiro/openExternalUrl": {
        // Bots run headless in a cluster: surface the fresh URL to the human (visible action
        // in the UI). Never log it.
        const url = isRecord(params) && typeof params.url === "string" ? params.url : undefined;
        emit({ type: "auth.required", kind: "mcp_oauth", ...(url ? { url } : {}), ...(isRecord(params) && typeof params.serverName === "string" ? { server: params.serverName } : {}) });
        return {};
      }
      case "_kiro/auth/getAccessToken": {
        if (!this.opts.accessToken) return undefined; // → explicit method-not-found error
        return this.opts.accessToken();
      }
      default:
        return undefined;
    }
  }
}

export function pickAnnotations(a: Record<string, unknown>): McpAnnotations {
  // Preserve the difference between "omitted" and explicit false.
  const out: McpAnnotations = {};
  for (const k of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
    if (typeof a[k] === "boolean") out[k] = a[k] as boolean;
  }
  return out;
}

/** `_kiro/mcp/status` is a full snapshot; accept list or map shapes. */
export function parseMcpSnapshot(p: Record<string, unknown>): McpServerStatus[] {
  const list = (Array.isArray(p.servers) && p.servers) || (Array.isArray(p.mcpServers) && p.mcpServers) || (Array.isArray(p.entries) && p.entries) || null;
  const entries: Array<[string, Record<string, unknown>]> = [];
  if (list) {
    for (const s of list) if (isRecord(s)) entries.push([String(s.name ?? s.serverName ?? "server"), s]);
  } else if (isRecord(p.servers)) {
    for (const [name, s] of Object.entries(p.servers)) if (isRecord(s)) entries.push([name, s]);
  }
  return entries.map(([name, s]) => ({
    name,
    state: String(s.status ?? s.state ?? "pending"),
    ...(typeof s.error === "string" ? { error: s.error } : isRecord(s.error) && typeof s.error.message === "string" ? { error: s.error.message } : {}),
    ...(s.failedAuthorization === true ? { failedAuthorization: true } : {}),
    ...(typeof s.toolCount === "number" ? { toolCount: s.toolCount } : Array.isArray(s.tools) ? { toolCount: s.tools.length } : {}),
  }));
}
