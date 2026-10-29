import type { AgentEvent, ContentPart, McpAnnotations, ToolIdentity } from "@orrery/core";
import type { AcpClient } from "../client.js";
import { collectMetering, toToolKind } from "../normalize.js";
import { getPath, isRecord, type RequestPermissionRequest, type RequestPermissionResponse, type SessionInfo, type SessionNotification } from "../protocol.js";
import { StandardAcpAdapter } from "./base.js";
import { pickAnnotations } from "./kiro-v3.js";
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
 * Kiro CLI v2 (`kiro-cli acp`), the legacy server generation.
 *
 * Wire reference: kiro.dev/docs/cli/acp (2.x) and the empirically verified 2.0.1–2.4.1 protocol
 * catalog. Differences from V3 handled here:
 *  - agent/model/effort via launch flags (--agent, --model) and `session/set_model`
 *  - fixed `_kiro.dev/*` extension catalog (no capability negotiation)
 *  - `_kiro.dev/metadata` for credits / context %, `_kiro.dev/session/update` tool_call_chunk previews
 *  - slash commands through `_kiro.dev/commands/execute` with `{ command: { command, args } }`
 *  - permissions: `_meta.trustOptions` / `_meta.trustOption`, flat `mcpToolIdentity` / `mcpAnnotations`
 *  - session discovery via `_kiro.dev/session/list`, steering via `_message/send`
 */
export class KiroV2Adapter extends StandardAcpAdapter {
  override readonly name: AdapterName = "kiro-v2";

  override launch(input: LaunchInput): LaunchSpec {
    const args = ["acp"];
    if (input.binding.modeId) args.push("--agent", input.binding.modeId);
    if (input.binding.modelId) args.push("--model", input.binding.modelId);
    // Trust flags are deliberately never passed: Orrery answers every permission request itself.
    return { command: input.binary, args, env: input.env ?? {} };
  }

  override supports(feature: AdapterFeature): boolean {
    switch (feature) {
      case "listSessions":
      case "steer":
      case "compact":
      case "usage":
      case "contextBreakdown":
      case "setModel":
      case "setEffort":
        return true;
      case "forkSession":
      case "resumeSession":
      case "closeSession":
        return false;
      default:
        return super.supports(feature);
    }
  }

  override captureSetup(res: Parameters<StandardAcpAdapter["captureSetup"]>[0]): SessionSetup {
    return { modes: res.modes ?? null, models: (res as { models?: SessionSetup["models"] }).models ?? null, configOptions: null };
  }

  override async configure(client: AcpClient, sessionId: string, setup: SessionSetup, binding: SessionInput["binding"]): Promise<AgentEvent[]> {
    const notices: AgentEvent[] = [];
    if (binding.modelId && setup.models && setup.models.currentModelId !== binding.modelId) {
      if (setup.models.availableModels.some((m) => m.modelId === binding.modelId)) {
        await client.setModel(sessionId, binding.modelId);
        setup.models.currentModelId = binding.modelId;
      } else {
        notices.push({ type: "notice", severity: "warning", title: `Model "${binding.modelId}" is not offered`, message: setup.models.availableModels.map((m) => m.modelId).join(", ") });
      }
    }
    if (binding.modeId && setup.modes && setup.modes.currentModeId !== binding.modeId) {
      notices.push(...(await this.applyMode(client, sessionId, setup, binding.modeId)));
    }
    if (binding.effort) {
      const r = await this.command(client, sessionId, "effort", { value: binding.effort });
      if (!r.success) notices.push({ type: "notice", severity: "warning", title: "Effort level not applied", ...(r.message ? { message: r.message } : {}) });
    }
    return notices;
  }

  /** `_kiro.dev/commands/execute` — note the nested `{ command: { command, args } }` shape. */
  async command(client: AcpClient, sessionId: string, command: string, args: Record<string, unknown> = {}): Promise<{ success: boolean; message?: string; data?: unknown }> {
    try {
      const res = await client.ext<{ success?: boolean; message?: string; data?: unknown }>("_kiro.dev/commands/execute", { sessionId, command: { command, args } }, 600_000);
      return { success: Boolean(res?.success), ...(res?.message ? { message: res.message } : {}), ...(res?.data !== undefined ? { data: res.data } : {}) };
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  override async listSessions(client: AcpClient, cwd: string): Promise<SessionInfo[]> {
    const res = await client.ext<{ sessions?: Array<Record<string, unknown>> }>("_kiro.dev/session/list", { cwd });
    return (res?.sessions ?? []).map((s) => ({ ...s, sessionId: String(s.sessionId), cwd, title: (s.sessionName as string | undefined) ?? (s.agentName as string | undefined) ?? null }));
  }

  override async steer(client: AcpClient, sessionId: string, parts: ContentPart[]): Promise<boolean> {
    await client.ext("_message/send", { sessionId, content: parts });
    return true;
  }

  override async compact(client: AcpClient, sessionId: string): Promise<boolean> {
    return (await this.command(client, sessionId, "compact")).success;
  }

  override async usage(client: AcpClient, sessionId: string): Promise<unknown> {
    return (await this.command(client, sessionId, "usage")).data ?? null;
  }

  override normalizeUpdate(n: SessionNotification, ctx: UpdateContext): AgentEvent[] {
    const tag = (n.update as { sessionUpdate?: string }).sessionUpdate;
    // v2 documented a TurnEnd update; turns still settle from the prompt response.
    if (tag === "turn_end" || tag === "TurnEnd") return [{ type: "session.info", kind: "turn_end", data: { ...n.update } }];
    return super.normalizeUpdate(n, ctx);
  }

  override normalizeExtNotification(method: string, params: unknown): ExtNotificationResult | null {
    const p = isRecord(params) ? params : {};
    const sessionId = typeof p.sessionId === "string" ? p.sessionId : undefined;
    const r = (events: AgentEvent[]): ExtNotificationResult => ({ ...(sessionId ? { sessionId } : {}), events });
    switch (method) {
      case "_kiro.dev/metadata": {
        const usage: Record<string, unknown> = {};
        if (typeof p.contextUsagePercentage === "number") usage.contextPercent = p.contextUsagePercentage;
        const metering = collectMetering(p.meteringUsage ?? []);
        if (Object.keys(metering).length) usage.metering = metering;
        if (typeof p.turnDurationMs === "number") usage.turnDurationMs = p.turnDurationMs;
        return r([{ type: "usage", usage }]);
      }
      case "_kiro.dev/session/update": {
        const u = isRecord(p.update) ? p.update : {};
        if (u.sessionUpdate === "tool_call_chunk" && typeof u.toolCallId === "string") {
          return r([{ type: "tool.preview", toolCallId: u.toolCallId, title: String(u.title ?? "tool"), kind: toToolKind(u.kind) }]);
        }
        return r([{ type: "extension", method, params }]);
      }
      case "_kiro.dev/commands/available": {
        const list = Array.isArray(p.commands) ? p.commands.filter(isRecord) : [];
        return r([
          {
            type: "commands.available",
            commands: list.map((c) => ({ name: String(c.name), description: String(c.description ?? ""), ...(isRecord(c.meta) ? { meta: c.meta } : {}) })),
          },
        ]);
      }
      case "_kiro.dev/compaction/status": {
        const st = isRecord(p.status) ? p.status : {};
        return r([{ type: "compaction", status: String(st.type ?? "unknown"), ...(typeof st.error === "string" ? { error: st.error } : {}) }]);
      }
      case "_kiro.dev/clear/status":
        return r([{ type: "session.info", kind: "clear", data: p }]);
      case "_kiro.dev/mcp/server_initialized":
        return r([{ type: "mcp.status", servers: [{ name: String(p.serverName ?? "server"), state: "connected" }] }]);
      case "_kiro.dev/mcp/server_init_failure":
        return r([{ type: "mcp.status", servers: [{ name: String(p.serverName ?? "server"), state: "failed", error: typeof p.error === "string" ? p.error : JSON.stringify(p.error ?? null) }] }]);
      case "_kiro.dev/mcp/oauth_request":
        return r([{ type: "auth.required", kind: "mcp_oauth", ...(typeof p.oauthUrl === "string" ? { url: p.oauthUrl } : {}), ...(typeof p.serverName === "string" ? { server: p.serverName } : {}) }]);
      case "_kiro.dev/error/rate_limit":
        return r([{ type: "rate_limited", message: String(p.message ?? "Rate limited") }]);
      case "_kiro.dev/agent/switched":
        return r([{ type: "mode.changed", modeId: String(p.agentName ?? "") }]);
      case "_kiro.dev/agent/not_found":
        return r([{ type: "notice", severity: "warning", title: `Agent "${String(p.requestedAgent)}" not found; using ${String(p.fallbackAgent)}` }]);
      case "_kiro.dev/agent/config_error":
        return r([{ type: "notice", severity: "error", title: `Agent config error in ${String(p.path)}`, message: JSON.stringify(p.error ?? null) }]);
      case "_kiro.dev/model/not_found":
        return r([{ type: "notice", severity: "warning", title: `Model "${String(p.requestedModel)}" not found; using ${String(p.fallbackModel)}` }]);
      case "_kiro.dev/subagent/list_update": {
        const subs = Array.isArray(p.subagents) ? p.subagents.filter(isRecord) : [];
        return r([
          {
            type: "subagents",
            entries: subs.map((s) => ({
              sessionId: String(s.sessionId),
              name: String(s.sessionName || s.agentName || "subagent"),
              status: String(getPath(s, ["status", "type"]) ?? "idle"),
              ...(typeof s.group === "string" ? { group: s.group } : {}),
              ...(typeof s.role === "string" ? { role: s.role } : {}),
            })),
          },
        ]);
      }
      case "_kiro.dev/session/activity":
      case "_kiro.dev/session/list_update":
      case "_kiro.dev/session/inbox_notification":
        return r([{ type: "session.info", kind: method.slice("_kiro.dev/".length), data: p }]);
      default:
        return r([{ type: "extension", method, params }]);
    }
  }

  protected override identityOf(req: RequestPermissionRequest): { identity?: ToolIdentity; annotations?: McpAnnotations } {
    // v2 used flat fields; accept them on the request _meta or the toolCall _meta.
    const metas = [req._meta, isRecord(req.toolCall) ? req.toolCall._meta : undefined, req];
    for (const m of metas) {
      if (!isRecord(m)) continue;
      const id = m.mcpToolIdentity;
      const ann = m.mcpAnnotations;
      if (isRecord(id) || isRecord(ann)) {
        const out: { identity?: ToolIdentity; annotations?: McpAnnotations } = {};
        if (isRecord(id)) {
          out.identity = {
            source: "mcp",
            ...(typeof (id.serverName ?? id.server) === "string" ? { server: String(id.serverName ?? id.server) } : {}),
            ...(typeof (id.toolName ?? id.tool) === "string" ? { tool: String(id.toolName ?? id.tool) } : {}),
          };
        }
        if (isRecord(ann)) out.annotations = pickAnnotations(ann);
        return out;
      }
    }
    return {};
  }

  override parsePermission(req: RequestPermissionRequest): NormalizedPermission {
    const perm = super.parsePermission(req);
    const trustOptions = getPath(req, ["_meta", "trustOptions"]);
    const fsReadPaths = getPath(req, ["_meta", "fsReadPaths"]);
    if (Array.isArray(trustOptions) || fsReadPaths !== undefined) {
      perm.legacy = { ...(Array.isArray(trustOptions) ? { trustOptions } : {}), ...(fsReadPaths !== undefined ? { fsReadPaths } : {}) };
    }
    return perm;
  }

  override permissionResponse(perm: NormalizedPermission, decision: PermissionDecision): RequestPermissionResponse {
    const base = super.permissionResponse(perm, decision);
    if (decision.outcome !== "selected" || !decision.persist || !perm.legacy?.trustOptions?.length) return base;
    // v2: echo the trust option whose pattern matches the requested persistent resource, if any.
    const match = perm.legacy.trustOptions.find((t) => {
      if (!isRecord(t)) return false;
      return [t.pattern, t.resource, t.value, t.id, t.label].some((v) => v === decision.persist!.resource);
    });
    return match ? { ...base, _meta: { trustOption: match } } : base;
  }
}
