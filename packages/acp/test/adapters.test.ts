import { describe, expect, it } from "vitest";
import { applyGuardrail, evaluatePolicy, foldTranscript, type AgentEvent } from "@orrery/core";
import { KiroV2Adapter, KiroV3Adapter, StandardAcpAdapter, detectKiroEngine, type RequestPermissionRequest, type SessionNotification } from "../src/index.js";

/* Fixtures are the JSON examples from https://kiro.dev/docs/cli/v3/acp-migration/ verbatim. */

const v3ConsentRequest: RequestPermissionRequest = {
  sessionId: "session-1",
  toolCall: { toolCallId: "call-1", title: "Run tests", status: "pending" },
  options: [
    { optionId: "accept", name: "Allow", kind: "allow_once" },
    { optionId: "always-accept", name: "Always allow", kind: "allow_always" },
    { optionId: "reject", name: "Deny", kind: "reject_once" },
    { optionId: "always-reject", name: "Always deny", kind: "reject_always" },
  ],
  _meta: {
    kiro: {
      consent: {
        capability: "shell",
        resource: "npm run test",
        triggeringResource: "npm run test",
        workspaceRoot: "/workspace/project",
        persistableConsent: true,
      },
    },
  },
};

const v3McpRequest: RequestPermissionRequest = {
  sessionId: "session-1",
  toolCall: { toolCallId: "call-2", title: "@example-server/search", status: "pending" },
  options: [
    { optionId: "accept", name: "Allow", kind: "allow_once" },
    { optionId: "reject", name: "Deny", kind: "reject_once" },
  ],
  _meta: {
    kiro: {
      mcpTool: {
        version: 1,
        identity: { serverName: "example-server", toolName: "search" },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
    },
  },
};

describe("Kiro V3 adapter", () => {
  const a = new KiroV3Adapter();
  a.onInitialized({
    protocolVersion: 1,
    agentCapabilities: { loadSession: true, mcpCapabilities: { http: true }, _meta: { kiro: { extensionMethods: ["_session/steer", "_kiro/session/compact"] } } },
  });

  it("launches the V3 engine without v2-only flags", () => {
    const spec = a.launch({ binary: "/usr/local/bin/kiro-cli", binding: { modeId: "vibe", modelId: "claude-sonnet", effort: "high", authMethod: "cli" } });
    expect(spec.args).toEqual(["acp", "--agent-engine=v3"]);
    expect(a.launch({ binary: "k", binding: { authMethod: "client" } }).args).toContain("--auth-method=client");
  });

  it("sends initial mode/model/effort under _meta.kiro on session/new", () => {
    const p = a.newSessionParams({ cwd: "/workspace/project", mcpServers: [], additionalDirectories: ["/workspace/shared"], binding: { modeId: "vibe", modelId: "claude-sonnet", effort: "high" } });
    expect(p).toEqual({ cwd: "/workspace/project", additionalDirectories: ["/workspace/shared"], mcpServers: [], _meta: { kiro: { modeId: "vibe", modelId: "claude-sonnet", effortLevel: "high" } } });
  });

  it("re-sends client-owned inputs on session/load", () => {
    const p = a.loadSessionParams("session-1", { cwd: "/w", mcpServers: [{ type: "http", name: "orrery", url: "http://x/mcp", headers: [] }], binding: {} });
    expect(p).toMatchObject({ sessionId: "session-1", cwd: "/w", mcpServers: [{ type: "http", name: "orrery" }] });
  });

  it("gates optional methods on the advertised extension list", () => {
    expect(a.supports("steer")).toBe(true);
    expect(a.supports("compact")).toBe(true);
    expect(a.supports("usage")).toBe(false);
  });

  it("parses consent into policy facts and keeps the offered options untouched", () => {
    const perm = a.parsePermission(v3ConsentRequest);
    expect(perm.options.map((o) => o.optionId)).toEqual(["accept", "always-accept", "reject", "always-reject"]);
    expect(perm.facts).toMatchObject({ capability: "shell", resource: "npm run test" });
    expect(perm.persistable).toBe(true);
    expect(evaluatePolicy({ defaultEffect: "ask", rules: [{ id: "npm", effect: "allow", capability: "shell", resource: "npm run *" }] }, perm.facts).effect).toBe("allow");
  });

  it("returns canonical consent metadata for a persistent choice", () => {
    const perm = a.parsePermission(v3ConsentRequest);
    const res = a.permissionResponse(perm, { outcome: "selected", optionId: "always-accept", persist: { scope: "workspace", resource: "npm run *" } });
    expect(res).toEqual({
      outcome: { outcome: "selected", optionId: "always-accept" },
      _meta: { kiro: { consent: { scope: "workspace", resource: "npm run *", workspaceRoot: "/workspace/project" } } },
    });
    // a one-time choice carries no consent metadata
    expect(a.permissionResponse(perm, { outcome: "selected", optionId: "accept", persist: { scope: "workspace", resource: "x" } })).toEqual({ outcome: { outcome: "selected", optionId: "accept" } });
  });

  it("never synthesizes an option the agent did not offer", () => {
    const perm = a.parsePermission(v3McpRequest);
    expect(() => a.permissionResponse(perm, { outcome: "selected", optionId: "always-accept" })).toThrow(/not offered/);
  });

  it("reads host-resolved MCP identity; annotations stay display-only", () => {
    const perm = a.parsePermission(v3McpRequest);
    expect(perm.identity).toEqual({ source: "mcp", server: "example-server", tool: "search" });
    expect(perm.annotations).toEqual({ readOnlyHint: true, openWorldHint: true });
    expect(perm.facts).toMatchObject({ capability: "mcp", resource: "example-server/search", mcpServer: "example-server", tool: "search" });
    // readOnlyHint must not relax a default-ask policy
    expect(evaluatePolicy({ defaultEffect: "ask", rules: [] }, perm.facts).effect).toBe("ask");
  });

  it("dispatches session_info_update by _meta.kiro.kind and ignores turn_end as completion", () => {
    const n = (kiro: Record<string, unknown>): SessionNotification => ({ sessionId: "s", update: { sessionUpdate: "session_info_update", _meta: { kiro } } });
    expect(a.normalizeUpdate(n({ kind: "context_usage", usagePercentage: 42 }), { messageId: "m" })).toEqual([{ type: "usage", usage: { contextPercent: 42 } }]);
    const tc = a.normalizeUpdate(n({ kind: "turn_completion", elapsedMs: 900, promptTurnSummaries: [{ meteringUsage: [{ unit: "credit", unitPlural: "credits", value: 0.5 }] }] }), { messageId: "m" });
    expect(tc[0]).toEqual({ type: "usage", usage: { metering: { credits: 0.5 }, turnDurationMs: 900 } });
    expect(a.normalizeUpdate(n({ kind: "turn_end" }), { messageId: "m" })).toEqual([{ type: "session.info", kind: "turn_end", data: { kind: "turn_end" } }]);
    expect(a.normalizeUpdate(n({ kind: "steering_injected", text: "hurry" }), { messageId: "m" })).toEqual([{ type: "steering", status: "injected", text: "hurry" }]);
  });

  it("marks replayed updates and applies failure reasons", () => {
    const replay = a.normalizeUpdate(
      { sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Previously streamed response" }, _meta: { kiro: { replay: true } } } },
      { messageId: "m" },
    );
    expect(replay).toEqual([{ type: "message.delta", messageId: "m", part: { type: "text", text: "Previously streamed response" }, replay: true }]);
    const failed = a.normalizeUpdate({ sessionId: "s", update: { sessionUpdate: "tool_call_update", toolCallId: "c", status: "failed", _meta: { kiro: { failureReason: "denied" } } } }, { messageId: "m" });
    expect(failed[0]).toMatchObject({ type: "tool.update", toolCallId: "c", patch: { status: "failed", failureReason: "denied" } });
  });

  it("treats _kiro/mcp/status as a full snapshot", () => {
    const r = a.normalizeExtNotification("_kiro/mcp/status", { servers: [{ name: "gh", status: "connected" }, { name: "jira", status: "failed", failedAuthorization: true }] });
    expect(r?.events).toEqual([{ type: "mcp.status", servers: [{ name: "gh", state: "connected" }, { name: "jira", state: "failed", failedAuthorization: true }] }]);
  });

  it("never fails on unknown update types", () => {
    const ev = a.normalizeUpdate({ sessionId: "s", update: { sessionUpdate: "hologram_update", foo: 1 } }, { messageId: "m" });
    expect(ev[0]).toMatchObject({ type: "unknown_update", kind: "hologram_update" });
  });
});

describe("Kiro v2 adapter", () => {
  const a = new KiroV2Adapter();
  a.onInitialized({ protocolVersion: 1, agentInfo: { name: "Kiro CLI Agent", version: "2.4.1" }, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false } } });

  it("uses launch flags for agent and model, never trust flags", () => {
    expect(a.launch({ binary: "kiro-cli", binding: { modeId: "my-agent", modelId: "claude-opus" } }).args).toEqual(["acp", "--agent", "my-agent", "--model", "claude-opus"]);
  });

  it("maps _kiro.dev/metadata to usage", () => {
    const r = a.normalizeExtNotification("_kiro.dev/metadata", {
      sessionId: "4dfac9d3",
      contextUsagePercentage: 7.11,
      meteringUsage: [{ unit: "credit", unitPlural: "credits", value: 0.018139567827529027 }],
      turnDurationMs: 1948,
    });
    expect(r).toEqual({ sessionId: "4dfac9d3", events: [{ type: "usage", usage: { contextPercent: 7.11, metering: { credits: 0.018139567827529027 }, turnDurationMs: 1948 } }] });
  });

  it("maps tool_call_chunk previews", () => {
    const r = a.normalizeExtNotification("_kiro.dev/session/update", { sessionId: "s", update: { sessionUpdate: "tool_call_chunk", toolCallId: "t1", title: "shell", kind: "execute" } });
    expect(r?.events).toEqual([{ type: "tool.preview", toolCallId: "t1", title: "shell", kind: "execute" }]);
  });

  it("reads flat legacy MCP identity and echoes trust options for persistent choices", () => {
    const perm = a.parsePermission({
      sessionId: "s",
      toolCall: { toolCallId: "t", title: "shell", kind: "execute", rawInput: { command: "npm test" } },
      options: [
        { optionId: "allow_once", name: "Yes", kind: "allow_once" },
        { optionId: "allow_always", name: "Always", kind: "allow_always" },
        { optionId: "reject_once", name: "No", kind: "reject_once" },
      ],
      _meta: { trustOptions: [{ id: "cmd", label: "Always trust npm *", pattern: "npm *" }] },
    });
    expect(perm.facts).toMatchObject({ capability: "shell", resource: "npm test" });
    expect(a.permissionResponse(perm, { outcome: "selected", optionId: "allow_always", persist: { scope: "workspace", resource: "npm *" } })).toEqual({
      outcome: { outcome: "selected", optionId: "allow_always" },
      _meta: { trustOption: { id: "cmd", label: "Always trust npm *", pattern: "npm *" } },
    });
  });
});

describe("engine detection and generic agents", () => {
  it("does not use protocolVersion to tell generations apart", () => {
    expect(detectKiroEngine({ protocolVersion: 1, agentInfo: { name: "Kiro CLI Agent", version: "3.0" }, agentCapabilities: { _meta: { kiro: { extensionMethods: [] } } } })).toBe("v3");
    expect(detectKiroEngine({ protocolVersion: 1, agentInfo: { name: "Kiro CLI Agent", version: "2.4.1" }, agentCapabilities: {} })).toBe("v2");
    expect(detectKiroEngine({ protocolVersion: 1, agentInfo: { name: "gemini-cli", version: "1" } })).toBe("unknown");
  });

  it("drops MCP transports the agent cannot use", () => {
    const g = new StandardAcpAdapter();
    g.onInitialized({ protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: false } } });
    const p = g.newSessionParams({ cwd: "/w", mcpServers: [{ type: "http", name: "h", url: "u", headers: [] }, { name: "s", command: "c", args: [], env: [] }], binding: {} });
    expect(p.mcpServers).toEqual([{ name: "s", command: "c", args: [], env: [] }]);
  });
});

describe("policy + guardrail composition", () => {
  it("deny beats ask beats allow; guardrails only tighten", () => {
    const policy = {
      defaultEffect: "allow" as const,
      rules: [
        { id: "a", effect: "allow" as const, capability: "shell", resource: "git *" },
        { id: "b", effect: "deny" as const, capability: "shell", resource: "git push --force*" },
      ],
    };
    expect(evaluatePolicy(policy, { capability: "shell", kind: "execute", resource: "git status" }).effect).toBe("allow");
    expect(evaluatePolicy(policy, { capability: "shell", kind: "execute", resource: "git push --force origin main" })).toMatchObject({ effect: "deny", matchedRule: "b" });
    const g = { enabled: true, askAbove: 0.5, denyAbove: 0.9 };
    expect(applyGuardrail({ effect: "allow" }, 0.6, g).effect).toBe("ask");
    expect(applyGuardrail({ effect: "allow" }, 0.95, g).effect).toBe("deny");
    expect(applyGuardrail({ effect: "deny" }, 0.01, g).effect).toBe("deny");
    expect(applyGuardrail({ effect: "ask" }, 0.01, g).effect).toBe("ask");
  });

  it("path globs stay within segments, command globs do not", () => {
    const policy = { defaultEffect: "deny" as const, rules: [{ id: "src", effect: "allow" as const, capability: "read", resource: "/w/src/*" }] };
    expect(evaluatePolicy(policy, { capability: "read", kind: "read", resource: "/w/src/a.ts" }).effect).toBe("allow");
    expect(evaluatePolicy(policy, { capability: "read", kind: "read", resource: "/w/src/deep/a.ts" }).effect).toBe("deny");
  });
});

describe("transcript folding", () => {
  it("folds deltas, tool patches and usage", () => {
    const events: AgentEvent[] = [
      { type: "message.delta", messageId: "m", part: { type: "text", text: "Hel" } },
      { type: "message.delta", messageId: "m", part: { type: "text", text: "lo" } },
      { type: "tool.call", call: { toolCallId: "t", title: "Run", kind: "execute", status: "pending" } },
      { type: "tool.update", toolCallId: "t", patch: { status: "completed" } },
      { type: "usage", usage: { metering: { credits: 1 } } },
      { type: "usage", usage: { metering: { credits: 0.5 }, contextPercent: 10 } },
      { type: "turn.completed", stopReason: "end_turn" },
    ];
    const t = foldTranscript(events);
    expect(t.assistantText).toBe("Hello");
    expect(t.tools[0]?.status).toBe("completed");
    expect(t.usage).toEqual({ metering: { credits: 1.5 }, contextPercent: 10 });
    expect(t.stopReason).toBe("end_turn");
  });
});
