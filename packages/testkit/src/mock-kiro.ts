import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { JsonRpcError, JsonRpcPeer, RPC_ERRORS, type MessageTransport } from "@orrery/acp";

/**
 * Wire-faithful mock of `kiro-cli acp` for both server generations:
 *
 *   v3: `kiro-cli acp --agent-engine=v3 [--auth-method=client]`
 *   v2: `kiro-cli acp [--agent X] [--model Y]`
 *
 * It reproduces the documented behaviours an integration must get right (capability
 * advertisement, set_config_option vs set_model, `_meta.kiro.*`, `_kiro.dev/*` extensions,
 * consent metadata, replay marking, steering, cancellation, session/list, auth callbacks) so
 * the whole platform can be tested — and demoed — without Kiro credentials.
 *
 * Prompt mini-language (one directive per line, anything else is echoed):
 *   run: <command>      shell tool call that requires permission
 *   read: <path>        read tool call (no permission)
 *   mcp: <server>/<tool> MCP tool call requiring permission (identity envelope)
 *   plan                emit a 3-step plan
 *   sleep: <ms>         wait (lets tests cancel / drop connections mid-turn)
 *   refuse              stopReason refusal
 *   fail                JSON-RPC error from session/prompt
 *   auth-url: <server>  ask the client to open an OAuth URL (V3 `_kiro/openExternalUrl`)
 */

export type MockGeneration = "v3" | "v2";

export interface MockKiroOptions {
  generation: MockGeneration;
  authMethod?: "cli" | "client";
  /** Launch flags (validated like the real CLI). */
  argv?: string[];
  stateDir?: string;
  agentVersion?: string;
}

interface SessionState {
  id: string;
  cwd: string;
  modeId: string;
  modelId: string;
  effortLevel: string;
  history: Array<{ role: "user" | "agent"; text: string }>;
  mcpServers: unknown[];
}

const MODES = [
  { id: "vibe", name: "Vibe", description: "Default agent" },
  { id: "planner", name: "Planner", description: "Plans before acting", _meta: { welcomeMessage: "Transform any idea into fully working code." } },
];
const MODELS = ["auto", "claude-sonnet", "claude-opus", "claude-haiku"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export const V3_EXTENSION_METHODS = [
  "_session/steer",
  "_kiro/session/compact",
  "_kiro/session/context",
  "_kiro/account/getUsage",
  "_kiro/session/rename",
  "_kiro/mcp/resetServer",
];

export class LaunchError extends Error {}

/** Validate CLI flags the way each generation does. */
export function validateLaunch(argv: string[], generation: MockGeneration): { engine: MockGeneration; authMethod: "cli" | "client"; agent?: string; model?: string } {
  if (argv[0] !== "acp") throw new LaunchError("error: unrecognized subcommand");
  const flags = argv.slice(1);
  const wantsV3 = flags.includes("--agent-engine=v3");
  if (generation === "v2" && wantsV3) throw new LaunchError("error: unexpected argument '--agent-engine' found");
  if (wantsV3) {
    for (const f of flags) {
      if (["--agent", "--model", "--effort", "--trust-all-tools", "--trust-tools"].some((x) => f === x || f.startsWith(`${x}=`))) {
        throw new LaunchError(`error: unexpected argument '${f.split("=")[0]}' found (not supported with --agent-engine=v3)`);
      }
    }
    const auth = flags.find((f) => f.startsWith("--auth-method="))?.split("=")[1];
    return { engine: "v3", authMethod: auth === "client" ? "client" : "cli" };
  }
  const get = (name: string) => {
    const i = flags.indexOf(name);
    return i >= 0 ? flags[i + 1] : undefined;
  };
  const agent = get("--agent");
  const model = get("--model");
  return { engine: "v2", authMethod: "cli", ...(agent ? { agent } : {}), ...(model ? { model } : {}) };
}

export class MockKiroAgent {
  readonly peer: JsonRpcPeer;
  private readonly sessions = new Map<string, SessionState>();
  /** Sessions persisted by an earlier process: listable and loadable, but not live until loaded (like real agents). */
  private readonly stored = new Map<string, SessionState>();
  private readonly active = new Map<string, { abort: AbortController; steering: string[] }>();
  private clientCaps: Record<string, unknown> = {};
  readonly engine: MockGeneration;
  private readonly authMethod: "cli" | "client";
  private readonly launchAgent: string | undefined;
  private readonly launchModel: string | undefined;

  constructor(transport: MessageTransport, private readonly opts: MockKiroOptions) {
    const launch = validateLaunch(opts.argv ?? (opts.generation === "v3" ? ["acp", "--agent-engine=v3"] : ["acp"]), opts.generation);
    this.engine = launch.engine;
    this.authMethod = opts.authMethod ?? launch.authMethod;
    this.launchAgent = launch.agent;
    this.launchModel = launch.model;
    this.peer = new JsonRpcPeer(transport, { name: `mock-kiro-${this.engine}` });
    this.loadState();
    this.register();
  }

  private allSessions(): Map<string, SessionState> {
    return new Map([...this.stored, ...this.sessions]);
  }

  private stateFile(): string | null {
    return this.opts.stateDir ? path.join(this.opts.stateDir, `mock-kiro-${this.engine}.json`) : null;
  }

  private loadState(): void {
    const f = this.stateFile();
    if (!f || !existsSync(f)) return;
    const data = JSON.parse(readFileSync(f, "utf8")) as SessionState[];
    for (const s of data) this.stored.set(s.id, s);
  }

  private saveState(): void {
    const f = this.stateFile();
    if (!f) return;
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify([...this.allSessions().values()]));
  }

  private configOptions(s: SessionState) {
    return [
      { id: "model", name: "Model", type: "select", category: "model", currentValue: s.modelId, options: MODELS.map((m) => ({ value: m, name: m })) },
      { id: "effortLevel", name: "Effort", type: "select", category: "thought_level", currentValue: s.effortLevel, options: EFFORTS.map((e) => ({ value: e, name: e })) },
    ];
  }

  private sessionSetup(s: SessionState): Record<string, unknown> {
    const modes = { currentModeId: s.modeId, availableModes: MODES };
    if (this.engine === "v3") return { modes, configOptions: this.configOptions(s) };
    return { modes, models: { currentModelId: s.modelId, availableModels: MODELS.map((m) => ({ modelId: m, name: m })) } };
  }

  private update(sessionId: string, update: Record<string, unknown>): void {
    this.peer.notify("session/update", { sessionId, update });
  }

  private register(): void {
    const p = this.peer;
    p.onRequest("initialize", (params) => {
      const req = params as { protocolVersion?: number; clientCapabilities?: Record<string, unknown> };
      this.clientCaps = req.clientCapabilities ?? {};
      const base = {
        protocolVersion: 1,
        agentInfo: { name: this.engine === "v3" ? "Kiro CLI Agent" : "Kiro CLI Agent", version: this.opts.agentVersion ?? (this.engine === "v3" ? "3.1.0" : "2.4.1") },
        authMethods: [],
      };
      if (this.engine === "v3") {
        return {
          ...base,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: true, audio: false, embeddedContext: true },
            mcpCapabilities: { http: true, sse: false },
            sessionCapabilities: { list: {}, fork: {}, additionalDirectories: {} },
            _meta: { kiro: { extensionMethods: V3_EXTENSION_METHODS, replayMarking: true } },
          },
        };
      }
      return { ...base, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false }, promptCapabilities: { audio: false, embeddedContext: false, image: true } } };
    });

    p.onRequest("session/new", async (params) => {
      const req = params as { cwd: string; mcpServers: unknown[]; _meta?: { kiro?: Record<string, string> } };
      if (typeof req.cwd !== "string" || !Array.isArray(req.mcpServers)) throw new JsonRpcError(RPC_ERRORS.invalidParams, "cwd and mcpServers are required");
      if (this.engine === "v3" && this.authMethod === "client") {
        const tok = (await p.request("_kiro/auth/getAccessToken", {}, { timeoutMs: 10_000 })) as { accessToken?: string } | null;
        if (!tok || typeof tok.accessToken !== "string") throw new JsonRpcError(RPC_ERRORS.authRequired, "authentication required");
      }
      const k = req._meta?.kiro ?? {};
      const s: SessionState = {
        id: randomUUID(),
        cwd: req.cwd,
        modeId: (this.engine === "v3" ? k.modeId : this.launchAgent) ?? "vibe",
        modelId: (this.engine === "v3" ? k.modelId : this.launchModel) ?? "auto",
        effortLevel: (this.engine === "v3" ? k.effortLevel : undefined) ?? "medium",
        history: [],
        mcpServers: req.mcpServers,
      };
      this.sessions.set(s.id, s);
      this.saveState();
      queueMicrotask(() => this.afterSessionCreated(s));
      return { sessionId: s.id, ...this.sessionSetup(s) };
    });

    p.onRequest("session/load", async (params) => {
      const req = params as { sessionId: string; cwd: string; mcpServers?: unknown[] };
      const s = this.sessions.get(req.sessionId) ?? this.stored.get(req.sessionId);
      if (!s) throw new JsonRpcError(RPC_ERRORS.invalidParams, `session not found: ${req.sessionId}`);
      this.sessions.set(s.id, s);
      if (this.engine === "v3" && !Array.isArray(req.mcpServers)) throw new JsonRpcError(RPC_ERRORS.invalidParams, "mcpServers must be re-sent on load");
      s.mcpServers = req.mcpServers ?? [];
      const replay = () => {
        for (const h of s.history) {
          const update: Record<string, unknown> = {
            sessionUpdate: h.role === "user" ? "user_message_chunk" : "agent_message_chunk",
            content: { type: "text", text: h.text },
          };
          if (this.engine === "v3") update._meta = { kiro: { replay: true } };
          this.update(s.id, update);
        }
      };
      if (this.engine === "v3") replay(); // V3: replay arrives during loading
      else setTimeout(replay, 0); // v2: replay after the response
      return this.sessionSetup(s);
    });

    p.onRequest("session/list", (params) => {
      if (this.engine !== "v3") throw new JsonRpcError(RPC_ERRORS.methodNotFound, "Method not found: session/list");
      const cwd = (params as { cwd?: string } | undefined)?.cwd;
      return { sessions: [...this.allSessions().values()].filter((s) => !cwd || s.cwd === cwd).map((s) => ({ sessionId: s.id, cwd: s.cwd, title: s.history[0]?.text.slice(0, 40) ?? null })) };
    });

    p.onRequest("session/fork", (params) => {
      if (this.engine !== "v3") throw new JsonRpcError(RPC_ERRORS.methodNotFound, "Method not found: session/fork");
      const req = params as { sessionId: string; cwd: string };
      const src = this.sessions.get(req.sessionId);
      if (!src) throw new JsonRpcError(RPC_ERRORS.invalidParams, "session not found");
      const s: SessionState = { ...src, id: randomUUID(), history: [...src.history], cwd: req.cwd };
      this.sessions.set(s.id, s);
      return { sessionId: s.id, ...this.sessionSetup(s) };
    });

    p.onRequest("session/set_mode", (params) => {
      const req = params as { sessionId: string; modeId: string };
      const s = this.mustSession(req.sessionId);
      if (!MODES.some((m) => m.id === req.modeId)) throw new JsonRpcError(RPC_ERRORS.invalidParams, `unknown mode ${req.modeId}`);
      const prev = s.modeId;
      s.modeId = req.modeId;
      this.update(s.id, { sessionUpdate: "current_mode_update", currentModeId: req.modeId });
      if (this.engine === "v2") p.notify("_kiro.dev/agent/switched", { sessionId: s.id, agentName: req.modeId, previousAgentName: prev, welcomeMessage: null });
      return {};
    });

    p.onRequest("session/set_config_option", (params) => {
      if (this.engine !== "v3") throw new JsonRpcError(RPC_ERRORS.methodNotFound, "Method not found: session/set_config_option");
      const req = params as { sessionId: string; configId: string; value: string };
      const s = this.mustSession(req.sessionId);
      if (req.configId === "model") {
        if (!MODELS.includes(req.value)) throw new JsonRpcError(RPC_ERRORS.invalidParams, `invalid model ${req.value}`);
        s.modelId = req.value;
      } else if (req.configId === "effortLevel") {
        if (!EFFORTS.includes(req.value)) throw new JsonRpcError(RPC_ERRORS.invalidParams, `invalid effort ${req.value}`);
        s.effortLevel = req.value;
      } else throw new JsonRpcError(RPC_ERRORS.invalidParams, `unknown config option ${req.configId}`);
      this.update(s.id, { sessionUpdate: "config_option_update", configOptions: this.configOptions(s) });
      return { configOptions: this.configOptions(s) };
    });

    p.onRequest("session/set_model", (params) => {
      if (this.engine === "v3") throw new JsonRpcError(RPC_ERRORS.methodNotFound, "Method not found: session/set_model");
      const req = params as { sessionId: string; modelId: string };
      const s = this.mustSession(req.sessionId);
      if (!MODELS.includes(req.modelId)) throw new JsonRpcError(RPC_ERRORS.invalidParams, `invalid model ${req.modelId}`);
      s.modelId = req.modelId;
      return {};
    });

    p.onNotification("session/cancel", (params) => {
      const id = (params as { sessionId: string }).sessionId;
      this.active.get(id)?.abort.abort();
    });

    p.onRequest("session/prompt", (params) => this.prompt(params as { sessionId: string; prompt: Array<{ type: string; text?: string }> }));

    // ---- extensions
    p.onRequest("_session/steer", (params) => {
      if (this.engine !== "v3") throw new JsonRpcError(RPC_ERRORS.methodNotFound, "Method not found: _session/steer");
      const req = params as { sessionId: string; prompt: Array<{ text?: string }> };
      const a = this.active.get(req.sessionId);
      const text = req.prompt.map((b) => b.text ?? "").join("");
      if (!a) return { outcome: "promptRequired" };
      a.steering.push(text);
      this.update(req.sessionId, { sessionUpdate: "session_info_update", _meta: { kiro: { kind: "steering_queued", text } } });
      return { outcome: "queued" };
    });
    p.onRequest("_kiro/session/compact", (params) => {
      const id = (params as { sessionId: string }).sessionId;
      this.update(id, { sessionUpdate: "session_info_update", _meta: { kiro: { kind: "summarization_started" } } });
      this.update(id, { sessionUpdate: "session_info_update", _meta: { kiro: { kind: "summarization_completed", summary: "compacted" } } });
      return {};
    });
    p.onRequest("_kiro/account/getUsage", () => ({ credits: { used: 12.5, limit: 1000 } }));
    p.onRequest("_kiro/session/context", () => ({ contextUsagePercentage: 7.1 }));
    p.onRequest("_message/send", (params) => {
      if (this.engine !== "v2") throw new JsonRpcError(RPC_ERRORS.methodNotFound, "Method not found: _message/send");
      const req = params as { sessionId: string; content: unknown };
      const a = this.active.get(req.sessionId);
      const text = Array.isArray(req.content) ? (req.content as Array<{ text?: string }>).map((b) => b.text ?? "").join("") : String(req.content);
      a?.steering.push(text);
      return {};
    });
    p.onRequest("_kiro.dev/session/list", (params) => {
      if (this.engine !== "v2") throw new JsonRpcError(RPC_ERRORS.methodNotFound, "Method not found");
      const cwd = (params as { cwd: string }).cwd;
      return { sessions: [...this.allSessions().values()].filter((s) => s.cwd === cwd).map((s) => ({ sessionId: s.id, sessionName: s.history[0]?.text.slice(0, 40) ?? "", agentName: s.modeId })) };
    });
    p.onRequest("_kiro.dev/commands/execute", (params) => {
      if (this.engine !== "v2") throw new JsonRpcError(RPC_ERRORS.methodNotFound, "Method not found");
      const req = params as { sessionId: string; command: { command: string; args: Record<string, unknown> } | string };
      if (typeof req.command !== "object") throw new JsonRpcError(RPC_ERRORS.invalidParams, "invalid type: string, expected TuiCommand");
      const s = this.mustSession(req.sessionId);
      switch (req.command.command) {
        case "effort":
          s.effortLevel = String(req.command.args.value);
          return { success: true, message: `Effort set to ${s.effortLevel}` };
        case "compact":
          p.notify("_kiro.dev/compaction/status", { sessionId: s.id, status: { type: "completed" } });
          return { success: true, message: "Compacted" };
        case "usage":
          return { success: true, data: { credits: { used: 3.2 } } };
        default:
          return { success: false, message: `unknown command ${req.command.command}` };
      }
    });
  }

  private mustSession(id: string): SessionState {
    const s = this.sessions.get(id);
    if (!s) throw new JsonRpcError(RPC_ERRORS.invalidParams, `unknown session ${id}`);
    return s;
  }

  private afterSessionCreated(s: SessionState): void {
    if (this.engine === "v3") {
      if (s.mcpServers.length) {
        this.peer.notify("_kiro/mcp/status", {
          sessionId: s.id,
          servers: s.mcpServers.map((m) => ({ name: (m as { name: string }).name, status: "connected", toolCount: 3 })),
        });
      }
      this.update(s.id, { sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact", description: "Compact the context" }] });
    } else {
      this.peer.notify("_kiro.dev/commands/available", { sessionId: s.id, commands: [{ name: "/model", description: "Switch model", meta: { inputType: "selection" } }], mcpServers: [] });
      for (const m of s.mcpServers) this.peer.notify("_kiro.dev/mcp/server_initialized", { serverName: (m as { name: string }).name });
    }
  }

  private async prompt(req: { sessionId: string; prompt: Array<{ type: string; text?: string }> }): Promise<{ stopReason: string }> {
    const s = this.mustSession(req.sessionId);
    if (this.active.has(s.id)) throw new JsonRpcError(RPC_ERRORS.invalidRequest, "a turn is already active for this session");
    const abort = new AbortController();
    const turn = { abort, steering: [] as string[] };
    this.active.set(s.id, turn);
    const text = req.prompt.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
    s.history.push({ role: "user", text });
    const started = Date.now();
    let reply = "";
    const say = (t: string) => {
      reply += t;
      this.update(s.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } });
    };
    const cancelled = () => abort.signal.aborted;
    try {
      this.update(s.id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Considering the request." } });
      for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (cancelled()) break;
        if (line.startsWith("run:")) {
          const ok = await this.toolWithPermission(s, "execute", line.slice(4).trim(), abort.signal);
          say(ok ? `Ran \`${line.slice(4).trim()}\`. ` : `Did not run \`${line.slice(4).trim()}\`. `);
        } else if (line.startsWith("mcp:")) {
          const ok = await this.toolWithPermission(s, "mcp", line.slice(4).trim(), abort.signal);
          say(ok ? `Called ${line.slice(4).trim()}. ` : `Skipped ${line.slice(4).trim()}. `);
        } else if (line.startsWith("read:")) {
          const file = line.slice(5).trim();
          const id = `tc_${randomUUID().slice(0, 8)}`;
          this.update(s.id, { sessionUpdate: "tool_call", toolCallId: id, title: `Reading ${path.basename(file)}`, kind: "read", status: "in_progress", rawInput: { path: file }, locations: [{ path: file, line: 1 }] });
          this.update(s.id, { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", content: [{ type: "content", content: { type: "text", text: `(mock contents of ${file})` } }] });
          say(`Read ${file}. `);
        } else if (line === "plan") {
          this.update(s.id, {
            sessionUpdate: "plan",
            entries: [
              { content: "Inspect the repository", priority: "high", status: "completed" },
              { content: "Make the change", priority: "high", status: "in_progress" },
              { content: "Run the tests", priority: "medium", status: "pending" },
            ],
          });
        } else if (line.startsWith("sleep:")) {
          const ms = Number(line.slice(6).trim()) || 0;
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, ms);
            abort.signal.addEventListener("abort", () => {
              clearTimeout(t);
              resolve();
            });
          });
        } else if (line === "refuse") {
          s.history.push({ role: "agent", text: "I can't help with that." });
          say("I can't help with that.");
          return { stopReason: "refusal" };
        } else if (line === "fail") {
          throw new JsonRpcError(RPC_ERRORS.internalError, "mock model failure");
        } else if (line.startsWith("auth-url:")) {
          const server = line.slice(9).trim();
          const caps = this.clientCaps._meta as { kiro?: { openExternalUrl?: boolean } } | undefined;
          if (this.engine === "v3" && caps?.kiro?.openExternalUrl) {
            await this.peer.request("_kiro/openExternalUrl", { url: `https://auth.example.com/oauth?server=${encodeURIComponent(server)}`, serverName: server });
            this.peer.notify("_kiro/mcp/status", { sessionId: s.id, servers: [{ name: server, status: "failed", failedAuthorization: true }] });
          } else if (this.engine === "v2") {
            this.peer.notify("_kiro.dev/mcp/oauth_request", { serverName: server, oauthUrl: `https://auth.example.com/oauth?server=${encodeURIComponent(server)}` });
          }
          say(`Authorization requested for ${server}. `);
        } else if (line) {
          say(`You said: ${line}. `);
        }
        while (turn.steering.length) {
          const steer = turn.steering.shift()!;
          if (this.engine === "v3") this.update(s.id, { sessionUpdate: "session_info_update", _meta: { kiro: { kind: "steering_injected", text: steer } } });
          say(`(steered: ${steer}) `);
        }
      }
      if (cancelled()) return { stopReason: "cancelled" };
      s.history.push({ role: "agent", text: reply });
      this.saveState();
      const elapsed = Date.now() - started;
      if (this.engine === "v3") {
        this.update(s.id, { sessionUpdate: "session_info_update", _meta: { kiro: { kind: "context_usage", usagePercentage: 12.5 } } });
        this.update(s.id, {
          sessionUpdate: "session_info_update",
          _meta: { kiro: { kind: "turn_completion", status: "completed", elapsedMs: elapsed, promptTurnSummaries: [{ meteringUsage: [{ unit: "credit", unitPlural: "credits", value: 0.02 }] }] } },
        });
        // Not a completion signal: the prompt response is.
        this.update(s.id, { sessionUpdate: "session_info_update", _meta: { kiro: { kind: "turn_end" } } });
      } else {
        this.peer.notify("_kiro.dev/metadata", { sessionId: s.id, contextUsagePercentage: 9.4, meteringUsage: [{ unit: "credit", unitPlural: "credits", value: 0.018 }], turnDurationMs: elapsed });
      }
      return { stopReason: "end_turn" };
    } finally {
      this.active.delete(s.id);
    }
  }

  private async toolWithPermission(s: SessionState, kind: "execute" | "mcp", target: string, signal: AbortSignal): Promise<boolean> {
    const id = `tc_${randomUUID().slice(0, 8)}`;
    const isMcp = kind === "mcp";
    const [server, tool] = isMcp ? target.split("/") : [undefined, undefined];
    const title = isMcp ? `@${server}/${tool}` : `Run \`${target}\``;
    if (this.engine === "v2") this.peer.notify("_kiro.dev/session/update", { sessionId: s.id, update: { sessionUpdate: "tool_call_chunk", toolCallId: id, title: isMcp ? tool : "shell", kind: isMcp ? "other" : "execute" } });
    const toolMeta = isMcp && this.engine === "v3" ? { _meta: { kiro: { mcpTool: { version: 1, identity: { serverName: server, toolName: tool }, annotations: { readOnlyHint: true, openWorldHint: true } } } } } : {};
    this.update(s.id, { sessionUpdate: "tool_call", toolCallId: id, title, kind: isMcp ? "other" : "execute", status: "pending", rawInput: isMcp ? { query: "x" } : { command: target }, ...toolMeta });

    const options =
      this.engine === "v3"
        ? [
            { optionId: "accept", name: "Allow", kind: "allow_once" },
            { optionId: "always-accept", name: "Always allow", kind: "allow_always" },
            { optionId: "reject", name: "Deny", kind: "reject_once" },
            { optionId: "always-reject", name: "Always deny", kind: "reject_always" },
          ]
        : [
            { optionId: "allow_once", name: "Yes", kind: "allow_once" },
            { optionId: "allow_always", name: "Always", kind: "allow_always" },
            { optionId: "reject_once", name: "No", kind: "reject_once" },
          ];
    let meta: Record<string, unknown> | undefined;
    if (this.engine === "v3") {
      meta = isMcp
        ? { kiro: { mcpTool: { version: 1, identity: { serverName: server, toolName: tool }, annotations: { readOnlyHint: true, openWorldHint: true } } } }
        : { kiro: { consent: { capability: "shell", resource: target, triggeringResource: target, workspaceRoot: s.cwd, persistableConsent: true } } };
    } else {
      meta = isMcp
        ? { mcpToolIdentity: { serverName: server, toolName: tool }, mcpAnnotations: { readOnlyHint: true } }
        : { trustOptions: [{ id: "cmd", label: `Always trust \`${target.split(" ")[0]} *\``, pattern: `${target.split(" ")[0]} *` }] };
    }
    const res = (await this.peer.request("session/request_permission", {
      sessionId: s.id,
      toolCall: { toolCallId: id, title, kind: isMcp ? "other" : "execute", status: "pending", rawInput: isMcp ? { query: "x" } : { command: target } },
      options,
      ...(meta ? { _meta: meta } : {}),
    })) as { outcome: { outcome: string; optionId?: string }; _meta?: unknown };

    if (signal.aborted || res.outcome.outcome === "cancelled") {
      this.update(s.id, { sessionUpdate: "tool_call_update", toolCallId: id, status: "failed", ...(this.engine === "v3" ? { _meta: { kiro: { failureReason: "cancelled" } } } : {}) });
      return false;
    }
    const chosen = options.find((o) => o.optionId === res.outcome.optionId);
    if (!chosen) throw new JsonRpcError(RPC_ERRORS.invalidParams, `client returned an option that was not offered: ${res.outcome.optionId}`);
    if (chosen.kind.startsWith("reject")) {
      this.update(s.id, { sessionUpdate: "tool_call_update", toolCallId: id, status: "failed", ...(this.engine === "v3" ? { _meta: { kiro: { failureReason: "denied" } } } : {}) });
      return false;
    }
    this.lastPermissionResponse = res;
    this.update(s.id, { sessionUpdate: "tool_call_update", toolCallId: id, status: "in_progress" });
    this.update(s.id, {
      sessionUpdate: "tool_call_update",
      toolCallId: id,
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: isMcp ? `(mock ${target} result)` : `$ ${target}\n(mock output)\nexit 0` } }],
    });
    return true;
  }

  /** Last permission response (lets tests assert on consent metadata). */
  lastPermissionResponse: unknown = null;
}
