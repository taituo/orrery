import { describe, expect, it } from "vitest";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { foldTranscript, type AgentEvent } from "@orrery/core";
import {
  KiroV2Adapter,
  KiroV3Adapter,
  StandardAcpAdapter,
  memoryTransportPair,
  runAcpTurn,
  spawnAgent,
  type MessageTransport,
  type NormalizedPermission,
  type PermissionDecision,
  type TurnController,
} from "@orrery/acp";
import { MockKiroAgent, startSdkEchoAgent } from "../src/index.js";

function mockConnector(generation: "v3" | "v2", stateDir?: string) {
  let agent: MockKiroAgent | null = null;
  return {
    get agent() {
      return agent!;
    },
    connect: async (): Promise<MessageTransport> => {
      const [client, server] = memoryTransportPair();
      agent = new MockKiroAgent(server, { generation, ...(stateDir ? { stateDir } : {}) });
      return client;
    },
  };
}

function collector(decide: (p: NormalizedPermission) => PermissionDecision = (p) => ({ outcome: "selected", optionId: p.options.find((o) => o.kind === "allow_once")!.optionId })) {
  const events: AgentEvent[] = [];
  const perms: NormalizedPermission[] = [];
  let controller: TurnController | null = null;
  return {
    events,
    perms,
    get controller() {
      return controller;
    },
    cb: {
      onEvent: (e: AgentEvent) => {
        events.push(e);
      },
      decidePermission: async (p: NormalizedPermission) => {
        perms.push(p);
        return decide(p);
      },
      onReady: (c: TurnController) => {
        controller = c;
      },
    },
  };
}

const session = (binding = {}) => ({ cwd: "/workspace/project", mcpServers: [{ type: "http" as const, name: "orrery", url: "http://api/mcp/bots/b1", headers: [] }], binding });

describe("runAcpTurn against Kiro CLI V3 (mock)", () => {
  it("runs a full turn: session/new with _meta.kiro, streaming, permission, usage, completion", async () => {
    const conn = mockConnector("v3");
    const c = collector();
    const res = await runAcpTurn(
      { connect: conn.connect, adapter: new KiroV3Adapter(), viaGateway: false },
      { requestKey: "run_1", messageId: "msg_1", session: session({ modeId: "planner", modelId: "claude-sonnet", effort: "high" }), prompt: [{ type: "text", text: "hello\nrun: npm test\nplan" }] },
      c.cb,
      new AbortController().signal,
    );
    expect(res.stopReason).toBe("end_turn");
    expect(res.createdSession).toBe(true);
    const t = foldTranscript(c.events);
    expect(t.assistantText).toContain("You said: hello.");
    expect(t.assistantText).toContain("Ran `npm test`.");
    expect(t.tools).toHaveLength(1);
    expect(t.tools[0]).toMatchObject({ kind: "execute", status: "completed" });
    expect(t.plan).toHaveLength(3);
    expect(t.usage).toMatchObject({ contextPercent: 12.5, metering: { credits: 0.02 } });
    expect(c.perms[0]!.consent).toMatchObject({ capability: "shell", resource: "npm test", persistableConsent: true });
    expect(c.events.at(-1)).toMatchObject({ type: "turn.completed", stopReason: "end_turn" });
    expect(c.events.some((e) => e.type === "mcp.status")).toBe(true);
    // initial values were applied through _meta.kiro (no extra set_config_option needed)
    expect(c.events.filter((e) => e.type === "notice")).toEqual([]);
  });

  it("returns canonical consent metadata for an 'always allow' with a pattern", async () => {
    const conn = mockConnector("v3");
    const c = collector((p) => ({ outcome: "selected", optionId: p.options.find((o) => o.kind === "allow_always")!.optionId, persist: { scope: "workspace", resource: "npm run *" } }));
    await runAcpTurn({ connect: conn.connect, adapter: new KiroV3Adapter(), viaGateway: false }, { requestKey: "r", messageId: "m", session: session(), prompt: [{ type: "text", text: "run: npm run build" }] }, c.cb, new AbortController().signal);
    expect(conn.agent.lastPermissionResponse).toEqual({
      outcome: { outcome: "selected", optionId: "always-accept" },
      _meta: { kiro: { consent: { scope: "workspace", resource: "npm run *", workspaceRoot: "/workspace/project" } } },
    });
  });

  it("denied tools surface the failure reason", async () => {
    const conn = mockConnector("v3");
    const c = collector((p) => ({ outcome: "selected", optionId: p.options.find((o) => o.kind === "reject_once")!.optionId }));
    await runAcpTurn({ connect: conn.connect, adapter: new KiroV3Adapter(), viaGateway: false }, { requestKey: "r", messageId: "m", session: session(), prompt: [{ type: "text", text: "run: rm -rf build" }] }, c.cb, new AbortController().signal);
    const t = foldTranscript(c.events);
    expect(t.tools[0]).toMatchObject({ status: "failed", failureReason: "denied" });
  });

  it("switches model via session/set_config_option on a loaded session, and suppresses replay", async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "mockkiro-"));
    const conn = mockConnector("v3", stateDir);
    const first = collector();
    const r1 = await runAcpTurn({ connect: conn.connect, adapter: new KiroV3Adapter(), viaGateway: false }, { requestKey: "r1", messageId: "m1", session: session(), prompt: [{ type: "text", text: "first message" }] }, first.cb, new AbortController().signal);
    const second = collector();
    const r2 = await runAcpTurn(
      { connect: conn.connect, adapter: new KiroV3Adapter(), viaGateway: false },
      { requestKey: "r2", messageId: "m2", sessionId: r1.sessionId, session: session({ modelId: "claude-opus" }), prompt: [{ type: "text", text: "second message" }] },
      second.cb,
      new AbortController().signal,
    );
    expect(r2.createdSession).toBe(false);
    expect(r2.sessionId).toBe(r1.sessionId);
    const text = foldTranscript(second.events).assistantText;
    expect(text).toContain("second message");
    expect(text).not.toContain("first message"); // replayed history is not re-emitted
    expect(second.events.some((e) => e.type === "config.changed" && e.options.some((o) => o.id === "model" && o.currentValue === "claude-opus"))).toBe(true);
  });

  it("rejects values the server does not advertise instead of sending them", async () => {
    const conn = mockConnector("v3");
    const c = collector();
    const stateDir = mkdtempSync(path.join(tmpdir(), "mockkiro-"));
    void stateDir;
    const r1 = await runAcpTurn({ connect: conn.connect, adapter: new KiroV3Adapter(), viaGateway: false }, { requestKey: "r", messageId: "m", session: session(), prompt: [{ type: "text", text: "x" }] }, collector().cb, new AbortController().signal);
    await runAcpTurn(
      { connect: async () => {
          const [client, server] = memoryTransportPair();
          // reuse the same agent state by re-wiring the existing mock's sessions
          const agent = new MockKiroAgent(server, { generation: "v3" });
          (agent as unknown as { sessions: Map<string, unknown> }).sessions = (conn.agent as unknown as { sessions: Map<string, unknown> }).sessions;
          return client;
        }, adapter: new KiroV3Adapter(), viaGateway: false },
      { requestKey: "r2", messageId: "m2", sessionId: r1.sessionId, session: session({ modelId: "gpt-imaginary" }), prompt: [{ type: "text", text: "y" }] },
      c.cb,
      new AbortController().signal,
    );
    expect(c.events.find((e) => e.type === "notice")).toMatchObject({ title: 'model "gpt-imaginary" is not offered by this agent' });
  });

  it("steers an active turn through _session/steer", async () => {
    const conn = mockConnector("v3");
    const c = collector();
    const p = runAcpTurn({ connect: conn.connect, adapter: new KiroV3Adapter(), viaGateway: false }, { requestKey: "r", messageId: "m", session: session(), prompt: [{ type: "text", text: "sleep: 150\nfinish" }] }, c.cb, new AbortController().signal);
    await new Promise((r) => setTimeout(r, 60));
    expect(await c.controller!.steer([{ type: "text", text: "use pnpm" }])).toBe(true);
    await p;
    expect(foldTranscript(c.events).assistantText).toContain("(steered: use pnpm)");
    expect(c.events.some((e) => e.type === "steering" && e.status === "queued")).toBe(true);
  });

  it("cancels: pending permissions resolve cancelled, then session/cancel, then the prompt response settles", async () => {
    const conn = mockConnector("v3");
    const ac = new AbortController();
    const c = {
      events: [] as AgentEvent[],
      cb: {
        onEvent: (e: AgentEvent) => void c.events.push(e),
        decidePermission: (_p: NormalizedPermission, signal: AbortSignal) =>
          new Promise<PermissionDecision>((_res, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")))),
      },
    };
    const p = runAcpTurn({ connect: conn.connect, adapter: new KiroV3Adapter(), viaGateway: false }, { requestKey: "r", messageId: "m", session: session(), prompt: [{ type: "text", text: "run: deploy prod\nsleep: 5000" }] }, c.cb, ac.signal);
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    const res = await p;
    expect(res.stopReason).toBe("cancelled");
    const t = foldTranscript(c.events);
    expect(t.tools[0]).toMatchObject({ status: "failed", failureReason: "cancelled" });
  });

  it("surfaces _kiro/openExternalUrl as auth.required (client advertises the capability)", async () => {
    const conn = mockConnector("v3");
    const c = collector();
    await runAcpTurn({ connect: conn.connect, adapter: new KiroV3Adapter(), viaGateway: false }, { requestKey: "r", messageId: "m", session: session(), prompt: [{ type: "text", text: "auth-url: jira" }] }, c.cb, new AbortController().signal);
    expect(c.events.find((e) => e.type === "auth.required")).toMatchObject({ kind: "mcp_oauth", server: "jira" });
    expect(c.events.find((e) => e.type === "mcp.status" && e.servers.some((s) => s.failedAuthorization))).toBeTruthy();
  });

  it("maps refusal and agent errors", async () => {
    const conn = mockConnector("v3");
    const c = collector();
    const r = await runAcpTurn({ connect: conn.connect, adapter: new KiroV3Adapter(), viaGateway: false }, { requestKey: "r", messageId: "m", session: session(), prompt: [{ type: "text", text: "refuse" }] }, c.cb, new AbortController().signal);
    expect(r.stopReason).toBe("refusal");
    expect(c.events.at(-1)).toMatchObject({ type: "turn.completed", refusal: true });
    await expect(
      runAcpTurn({ connect: conn.connect, adapter: new KiroV3Adapter(), viaGateway: false }, { requestKey: "r2", messageId: "m", session: session(), prompt: [{ type: "text", text: "fail" }] }, collector().cb, new AbortController().signal),
    ).rejects.toMatchObject({ code: "provider_error" });
  });

  it("answers _kiro/auth/getAccessToken when launched with --auth-method=client", async () => {
    const [client, server] = memoryTransportPair();
    new MockKiroAgent(server, { generation: "v3", argv: ["acp", "--agent-engine=v3", "--auth-method=client"] });
    const c = collector();
    const r = await runAcpTurn(
      { connect: async () => client, adapter: new KiroV3Adapter({ accessToken: async () => ({ accessToken: "tok_test" }) }), viaGateway: false },
      { requestKey: "r", messageId: "m", session: session(), prompt: [{ type: "text", text: "hi" }] },
      c.cb,
      new AbortController().signal,
    );
    expect(r.stopReason).toBe("end_turn");
  });
});

describe("runAcpTurn against Kiro CLI v2 (mock)", () => {
  it("uses set_model, _kiro.dev metadata, tool previews and trustOptions", async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "mockkiro2-"));
    const conn = mockConnector("v2", stateDir);
    const c = collector((p) => ({ outcome: "selected", optionId: "allow_always", persist: { scope: "workspace", resource: "npm *" } }));
    const r1 = await runAcpTurn({ connect: conn.connect, adapter: new KiroV2Adapter(), viaGateway: false }, { requestKey: "r", messageId: "m", session: session(), prompt: [{ type: "text", text: "run: npm test" }] }, c.cb, new AbortController().signal);
    expect(r1.stopReason).toBe("end_turn");
    expect(c.events.some((e) => e.type === "tool.preview")).toBe(true);
    expect(foldTranscript(c.events).usage).toMatchObject({ contextPercent: 9.4, metering: { credits: 0.018 } });
    expect(conn.agent.lastPermissionResponse).toMatchObject({ _meta: { trustOption: { pattern: "npm *" } } });

    // second turn on the same session switches the model with session/set_model; v2 replays
    // history *after* the load response — still not re-emitted.
    const c2 = collector();
    await runAcpTurn(
      { connect: conn.connect, adapter: new KiroV2Adapter(), viaGateway: false },
      { requestKey: "r2", messageId: "m2", sessionId: r1.sessionId, session: session({ modelId: "claude-opus", effort: "high" }), prompt: [{ type: "text", text: "next" }] },
      c2.cb,
      new AbortController().signal,
    );
    expect(c2.events.filter((e) => e.type === "notice")).toEqual([]);
    expect(foldTranscript(c2.events).assistantText).toBe("You said: next. ");
  });

  it("steers via _message/send and lists sessions via _kiro.dev/session/list", async () => {
    const conn = mockConnector("v2");
    const c = collector();
    const adapter = new KiroV2Adapter();
    const p = runAcpTurn({ connect: conn.connect, adapter, viaGateway: false }, { requestKey: "r", messageId: "m", session: session(), prompt: [{ type: "text", text: "sleep: 120\ndone" }] }, c.cb, new AbortController().signal);
    await new Promise((r) => setTimeout(r, 50));
    await c.controller!.steer([{ type: "text", text: "be brief" }]);
    await p;
    expect(foldTranscript(c.events).assistantText).toContain("(steered: be brief)");
  });
});

describe("real process: mock kiro-cli over stdio", () => {
  const cli = path.resolve(__dirname, "../src/mock-kiro-cli.ts");
  const spawnMock = (args: string[], generation: "v3" | "v2") =>
    spawnAgent({ command: process.execPath, args: ["--conditions=@orrery/source", "--import", "tsx", cli, ...args], env: { MOCK_KIRO_GENERATION: generation } });

  it("V3 binary rejects v2-only launch flags", async () => {
    const proc = spawnMock(["acp", "--agent-engine=v3", "--agent", "x"], "v3");
    const exit = await proc.exited;
    expect(exit.code).toBe(2);
  });

  it("v2 binary rejects --agent-engine; adapter launch specs are accepted by the right generation", async () => {
    const proc = spawnMock(["acp", "--agent-engine=v3"], "v2");
    expect((await proc.exited).code).toBe(2);
    const spec = new KiroV3Adapter().launch({ binary: "kiro-cli", binding: {} });
    const ok = spawnMock(spec.args, "v3");
    const c = collector();
    const r = await runAcpTurn({ connect: async () => ok.transport, adapter: new KiroV3Adapter(), viaGateway: false }, { requestKey: "r", messageId: "m", session: session(), prompt: [{ type: "text", text: "over stdio" }] }, c.cb, new AbortController().signal);
    expect(r.stopReason).toBe("end_turn");
    expect(foldTranscript(c.events).assistantText).toContain("over stdio");
    ok.kill();
  }, 30_000);
});

describe("interop with the official ACP SDK (generic agent)", () => {
  it("completes a standard turn with a permission round trip", async () => {
    const agent = startSdkEchoAgent();
    const c = collector();
    const r = await runAcpTurn({ connect: async () => agent.clientTransport, adapter: new StandardAcpAdapter(), viaGateway: false }, { requestKey: "r", messageId: "m", session: { cwd: "/w", mcpServers: [], binding: {} }, prompt: [{ type: "text", text: "ping" }] }, c.cb, new AbortController().signal);
    expect(r.stopReason).toBe("end_turn");
    const t = foldTranscript(c.events);
    expect(t.assistantText).toBe("echo: ping");
    expect(t.tools[0]?.status).toBe("completed");
    expect(c.events.at(-1)).toMatchObject({ type: "turn.completed", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
    agent.close();
  });
});
