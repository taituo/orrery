import type { AgentEvent } from "@orrery/core";
import type { RequestPermissionRequest, SessionNotification } from "../protocol.js";
import { isRecord } from "../protocol.js";
import { StandardAcpAdapter } from "./base.js";
import type { AdapterFeature, AdapterName, LaunchInput, LaunchSpec, NormalizedPermission, UpdateContext } from "./types.js";

/**
 * OpenCode (`opencode acp`), verified against opencode 1.19.5:
 *
 * - Launch: `opencode acp [--cwd <dir>] [--pure]`; configuration comes from
 *   OPENCODE_CONFIG_CONTENT (Orrery generates it: providers, permissions, instructions).
 * - Session setup is advertised as config options: `model` ("provider/model") and `mode`
 *   (OpenCode agents: build, plan, custom). Both are applied with session/set_config_option;
 *   values are checked against what the session offers.
 * - Standard tool_call / tool_call_update / agent_message_chunk updates; the first tool_call
 *   is a placeholder (title = tool name, empty input) that later updates fill in.
 * - session/request_permission offers once / always / reject. For some tools (read, glob, …)
 *   the request carries an empty rawInput; the adapter fills it from the tool call it has
 *   already seen so Orrery policies match on the real path or command.
 * - session/load replays history as ordinary updates (no replay marker); the turn runner
 *   ignores content outside an in-flight prompt. session/list, resume, fork and close exist.
 * - File writes go through the client's fs/write_text_file (the gateway's workspace jail).
 * - No mid-turn steering and no ACP compaction; usage arrives with the prompt response.
 */
export class OpenCodeAdapter extends StandardAcpAdapter {
  override readonly name: AdapterName = "opencode";
  /** Latest known state of each tool call (rawInput, title, locations), by id. */
  private readonly toolState = new Map<string, { title?: string; rawInput?: unknown; locations?: unknown }>();

  constructor(private readonly opts: { pure?: boolean } = {}) {
    super();
  }

  override launch(input: LaunchInput): LaunchSpec {
    const args = ["acp", ...(input.cwd ? ["--cwd", input.cwd] : []), ...(this.opts.pure ? ["--pure"] : [])];
    return { command: input.binary, args, env: input.env ?? {} };
  }

  override supports(feature: AdapterFeature): boolean {
    if (feature === "steer" || feature === "compact" || feature === "usage" || feature === "contextBreakdown") return false;
    if (feature === "setModel" || feature === "setMode") return true;
    if (feature === "setEffort") return false;
    return super.supports(feature);
  }

  override normalizeUpdate(n: SessionNotification, ctx: UpdateContext): AgentEvent[] {
    const u = isRecord(n.update) ? n.update : null;
    if (u && (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") && typeof u.toolCallId === "string") {
      const prev = this.toolState.get(u.toolCallId) ?? {};
      const hasInput = isRecord(u.rawInput) && Object.keys(u.rawInput).some((k) => k !== "cwd");
      this.toolState.set(u.toolCallId, {
        title: typeof u.title === "string" ? u.title : prev.title,
        rawInput: hasInput ? u.rawInput : prev.rawInput ?? u.rawInput,
        locations: Array.isArray(u.locations) && u.locations.length ? u.locations : prev.locations,
      });
      if (this.toolState.size > 2000) this.toolState.delete(this.toolState.keys().next().value!);
    }
    return super.normalizeUpdate(n, ctx);
  }

  override parsePermission(req: RequestPermissionRequest): NormalizedPermission {
    const tc: Record<string, unknown> = isRecord(req.toolCall) ? req.toolCall : {};
    const id = typeof tc.toolCallId === "string" ? tc.toolCallId : "";
    const known = this.toolState.get(id);
    const emptyInput = !isRecord(tc.rawInput) || Object.keys(tc.rawInput).length === 0;
    if (known && emptyInput && known.rawInput !== undefined) {
      const locations = Array.isArray(tc.locations) && tc.locations.length ? tc.locations : known.locations;
      const enriched = { ...req, toolCall: { ...tc, rawInput: known.rawInput, ...(locations ? { locations } : {}) } } as RequestPermissionRequest;
      return super.parsePermission(enriched);
    }
    return super.parsePermission(req);
  }
}

/** Platform-wide OpenCode settings that Orrery writes into OPENCODE_CONFIG_CONTENT. */
export interface OpenCodeConfigInput {
  /** OpenCode model ids ("provider/model"). */
  model?: string;
  smallModel?: string;
  agent?: string;
  /** orrery: ask over ACP for every tool (Orrery policy decides); agent: OpenCode's own rules. */
  permissions: "orrery" | "agent";
  /** Orrery OpenAI-compatible providers exposed to OpenCode as `orrery-<id>`. */
  providers: Array<{ id: string; name?: string; baseUrl: string; apiKeyEnv?: string; headers?: Record<string, string>; models: string[]; tools?: boolean; vision?: boolean }>;
  /** Files OpenCode loads as standing instructions (the bot's steering). */
  instructions?: string[];
  /**
   * The agent's workspace. With permissions=orrery project config is not loaded (see
   * openCodeEnvironment), so the workspace's AGENTS.md is listed explicitly instead.
   */
  workspace?: string;
  /** Extra user config merged in (cannot loosen the permission default when permissions=orrery). */
  extra?: Record<string, unknown>;
}

/** OpenCode's built-in agents that run tools; each gets Orrery's rule explicitly. */
export const OPENCODE_TOOL_AGENTS = ["build", "plan", "general", "explore"] as const;

const ASK_ALL = { "*": "ask" } as const;

/** Build the opencode.json Orrery runs OpenCode with. */
export function openCodeConfig(input: OpenCodeConfigInput): Record<string, unknown> {
  const provider: Record<string, unknown> = {};
  for (const p of input.providers) {
    if (!p.models.length) continue;
    provider[`orrery-${p.id}`] = {
      npm: "@ai-sdk/openai-compatible",
      name: p.name ?? `Orrery: ${p.id}`,
      options: {
        baseURL: p.baseUrl,
        ...(p.apiKeyEnv ? { apiKey: `{env:${p.apiKeyEnv}}` } : { apiKey: "unused" }),
        ...(p.headers && Object.keys(p.headers).length ? { headers: p.headers } : {}),
      },
      models: Object.fromEntries(p.models.map((m) => [m, { name: m, tool_call: p.tools !== false, ...(p.vision ? { attachment: true } : {}) }])),
    };
  }
  const extra = input.extra ?? {};
  const orrery = input.permissions === "orrery";
  const instructions = [
    ...(Array.isArray(extra.instructions) ? (extra.instructions as string[]) : []),
    ...(input.instructions ?? []),
    ...(orrery && input.workspace ? [`${input.workspace.replace(/\/+$/, "")}/AGENTS.md`] : []),
  ];
  const base: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    ...extra,
    ...(Object.keys(provider).length || isRecord(extra.provider) ? { provider: { ...(isRecord(extra.provider) ? extra.provider : {}), ...provider } } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.smallModel ? { small_model: input.smallModel } : {}),
    ...(input.agent ? { default_agent: input.agent } : {}),
    ...(instructions.length ? { instructions } : {}),
  };
  // Orrery governs tools: every call is asked over ACP and decided by the bot's policy.
  // Verified against opencode 1.19.5: an agent-level `permission` in any lower-precedence
  // config overrides the top-level one, so every tool-running agent — built-in or defined in
  // the extra config — gets the rule explicitly, and the inline config (applied last) wins.
  if (orrery) {
    base.permission = { ...ASK_ALL };
    const agents: Record<string, unknown> = isRecord(extra.agent) ? { ...extra.agent } : {};
    for (const name of OPENCODE_TOOL_AGENTS) agents[name] = { ...(isRecord(agents[name]) ? agents[name] : {}) };
    base.agent = Object.fromEntries(Object.entries(agents).map(([name, def]) => [name, { ...(isRecord(def) ? def : {}), permission: { ...ASK_ALL } }]));
    if (isRecord(extra.mode)) base.mode = Object.fromEntries(Object.entries(extra.mode).map(([name, def]) => [name, { ...(isRecord(def) ? def : {}), permission: { ...ASK_ALL } }]));
  }
  return base;
}

/**
 * Environment for an OpenCode agent process run by Orrery.
 *
 * With permissions=orrery, project configuration (opencode.json and .opencode/ in the
 * workspace) is not loaded: the agent can write to its workspace, and a project config could
 * otherwise grant itself permissions. The workspace's AGENTS.md is still read (listed in
 * `instructions`).
 */
export function openCodeEnvironment(input: OpenCodeConfigInput & { offline?: boolean }): Record<string, string> {
  const { offline, ...config } = input;
  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify(openCodeConfig(config)),
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    ...(input.permissions === "orrery" ? { OPENCODE_DISABLE_PROJECT_CONFIG: "true" } : {}),
    // Without internet egress, skip the models.dev catalogue fetch (the bundled copy is used).
    ...(offline ? { OPENCODE_DISABLE_MODELS_FETCH: "true" } : {}),
  };
}
