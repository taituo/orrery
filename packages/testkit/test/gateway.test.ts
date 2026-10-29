import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { signToken, foldTranscript, deferred, type AgentEvent } from "@orrery/core";
import {
  GATEWAY_TOKEN_AUDIENCE,
  KiroV2Adapter,
  KiroV3Adapter,
  connectWebSocket,
  memoryTransportPair,
  runAcpTurn,
  type MessageTransport,
  type NormalizedPermission,
  type PermissionDecision,
  type TurnProgress,
} from "@orrery/acp";
import { AcpGateway, startGatewayServer, type AgentProcess } from "@orrery/acp-gateway";
import { MockKiroAgent } from "../src/index.js";

const SECRET = "test-secret-test-secret";
const COMPUTER = "cmp_test";

interface Harness {
  url: string;
  gateway: AcpGateway;
  server: Server;
  agents: MockKiroAgent[];
  prompts: () => number;
  killAgent(): void;
}

let current: Harness | null = null;

async function startHarness(generation: "v3" | "v2" = "v3"): Promise<Harness> {
  const agents: MockKiroAgent[] = [];
  let promptCount = 0;
  let kill: () => void = () => undefined;
  const workspace = mkdtempSync(path.join(tmpdir(), "gw-ws-"));
  const gateway = new AcpGateway({
    workspaceRoots: [workspace],
    defaultCwd: workspace,
    spawnAgent: (): AgentProcess => {
      const [down, agentSide] = memoryTransportPair();
      const agent = new MockKiroAgent(agentSide, { generation });
      agent.peer.tap = (dir, m) => {
        if (dir === "in" && "method" in m && m.method === "session/prompt") promptCount++;
      };
      agents.push(agent);
      const exited = deferred<{ code: number | null; signal: string | null }>();
      kill = () => {
        agentSide.close("killed");
        exited.resolve({ code: null, signal: "SIGKILL" });
      };
      return { transport: down, pid: 4242, exited: exited.promise, kill: () => kill() };
    },
  });
  await gateway.start();
  const server = await startGatewayServer(gateway, { port: 0, host: "127.0.0.1", tokenSecret: SECRET, computerId: COMPUTER });
  const port = (server.address() as { port: number }).port;
  current = { url: `ws://127.0.0.1:${port}/acp`, gateway, server, agents, prompts: () => promptCount, killAgent: () => kill() };
  return current;
}

afterEach(async () => {
  if (!current) return;
  current.server.close();
  await current.gateway.stop();
  current = null;
});

const token = () => signToken({ sub: COMPUTER, aud: GATEWAY_TOKEN_AUDIENCE, exp: Math.floor(Date.now() / 1000) + 600 }, SECRET);
const session = { cwd: "/workspace", mcpServers: [], binding: {} };

function recorder() {
  const events: AgentEvent[] = [];
  let progress: TurnProgress | null = null;
  return {
    events,
    get progress() {
      return progress;
    },
    onEvent: (e: AgentEvent) => void events.push(e),
    onProgress: (p: TurnProgress) => {
      progress = p;
    },
  };
}

const allowOnce = async (p: NormalizedPermission): Promise<PermissionDecision> => ({ outcome: "selected", optionId: p.options.find((o) => o.kind === "allow_once")!.optionId });

describe("ACP gateway", () => {
  it("rejects unauthenticated or wrong-computer connections", async () => {
    const h = await startHarness();
    await expect(connectWebSocket({ url: h.url })).rejects.toThrow(/401/);
    const wrong = signToken({ sub: "cmp_other", aud: GATEWAY_TOKEN_AUDIENCE, exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
    await expect(connectWebSocket({ url: h.url, token: wrong })).rejects.toThrow(/401/);
  });

  it("relays a full Kiro V3 turn over WebSocket", async () => {
    const h = await startHarness();
    const r = recorder();
    const res = await runAcpTurn(
      { connect: () => connectWebSocket({ url: h.url, token: token() }), adapter: new KiroV3Adapter(), viaGateway: true },
      { requestKey: "run_a", messageId: "m", session, prompt: [{ type: "text", text: "hello gateway\nrun: ls -la" }] },
      { ...r, decidePermission: allowOnce },
      new AbortController().signal,
    );
    expect(res.stopReason).toBe("end_turn");
    expect(res.agentEpoch).toBe(h.gateway.agentEpoch);
    expect(foldTranscript(r.events).assistantText).toContain("You said: hello gateway.");
    expect(h.prompts()).toBe(1);
  });

  it("relays a full Kiro v2 turn: extension notifications stay ordered with session updates", async () => {
    // v2 interleaves `_kiro.dev/*` notifications (metadata, commands) with `session/update`;
    // all share the gateway's per-session seq, so none may be dropped as a replay duplicate.
    for (let i = 0; i < 5; i++) {
      const h = await startHarness("v2");
      const r = recorder();
      const res = await runAcpTurn(
        { connect: () => connectWebSocket({ url: h.url, token: token() }), adapter: new KiroV2Adapter(), viaGateway: true },
        { requestKey: `run_v2_${i}`, messageId: "m", session, prompt: [{ type: "text", text: "hello v2\nrun: echo hi\nplan" }] },
        { ...r, decidePermission: allowOnce },
        new AbortController().signal,
      );
      expect(res.stopReason).toBe("end_turn");
      const t = foldTranscript(r.events);
      expect(t.assistantText).toBe("You said: hello v2. Ran `echo hi`. ");
      expect(t.thoughtText).toContain("Considering");
      expect(t.tools.map((x) => x.status)).toEqual(["completed"]);
      expect(t.plan.length).toBe(3);
      expect(r.events.some((e) => e.type === "usage" && e.usage.metering?.credits)).toBe(true);
      current!.server.close();
      await current!.gateway.stop();
      current = null;
    }
  });

  it("survives a dropped connection mid-turn: reconnects, replays by seq, never re-prompts", async () => {
    const h = await startHarness();
    const r = recorder();
    let first: MessageTransport | null = null;
    const connect = async () => {
      const t = await connectWebSocket({ url: h.url, token: token() });
      if (!first) first = t;
      return t;
    };
    const p = runAcpTurn(
      { connect, adapter: new KiroV3Adapter(), viaGateway: true, maxReconnects: 3 },
      { requestKey: "run_b", messageId: "m", session, prompt: [{ type: "text", text: "before\nsleep: 300\nafter" }] },
      { ...r, decidePermission: allowOnce },
      new AbortController().signal,
    );
    await new Promise((res) => setTimeout(res, 120));
    first!.close("network blip");
    const res = await p;
    expect(res.stopReason).toBe("end_turn");
    const text = foldTranscript(r.events).assistantText;
    expect(text).toBe("You said: before. You said: after. ");
    expect(h.prompts()).toBe(1);
  });

  it("resumes a turn from a new activity attempt after the worker died (held permission is re-delivered)", async () => {
    const h = await startHarness();
    const r1 = recorder();
    let t1: MessageTransport | null = null;
    const permissionSeen = deferred<void>();
    const a = runAcpTurn(
      {
        connect: async () => {
          if (t1) throw new Error("worker is dead");
          t1 = await connectWebSocket({ url: h.url, token: token() });
          return t1;
        },
        adapter: new KiroV3Adapter(),
        viaGateway: true,
        maxReconnects: 0,
      },
      { requestKey: "run_c", messageId: "m", session, prompt: [{ type: "text", text: "start\nrun: make deploy\nend" }] },
      {
        ...r1,
        decidePermission: () => {
          permissionSeen.resolve();
          return new Promise<PermissionDecision>(() => undefined); // the human never answers on this worker
        },
      },
      new AbortController().signal,
    );
    await permissionSeen.promise;
    t1!.close("worker crashed");
    await expect(a).rejects.toMatchObject({ code: "interrupted" });
    const progress = r1.progress!;
    expect(progress.promptSent).toBe(true);

    // Temporal retries the activity with the heartbeat details.
    const r2 = recorder();
    const res = await runAcpTurn(
      { connect: () => connectWebSocket({ url: h.url, token: token() }), adapter: new KiroV3Adapter(), viaGateway: true },
      {
        requestKey: "run_c",
        messageId: "m",
        session,
        prompt: [{ type: "text", text: "start\nrun: make deploy\nend" }],
        resume: { sessionId: progress.sessionId!, afterSeq: progress.lastSeq, agentEpoch: progress.agentEpoch, promptSent: true },
      },
      { ...r2, decidePermission: allowOnce },
      new AbortController().signal,
    );
    expect(res.stopReason).toBe("end_turn");
    expect(h.prompts()).toBe(1);
    const text = foldTranscript([...r1.events, ...r2.events]).assistantText;
    expect(text).toBe("You said: start. Ran `make deploy`. You said: end. ");
  });

  it("reports interruption (and does not resend) when the agent process restarts mid-turn", async () => {
    const h = await startHarness();
    const r = recorder();
    const p = runAcpTurn(
      { connect: () => connectWebSocket({ url: h.url, token: token() }), adapter: new KiroV3Adapter(), viaGateway: true },
      { requestKey: "run_d", messageId: "m", session, prompt: [{ type: "text", text: "sleep: 400" }] },
      { ...r, decidePermission: allowOnce },
      new AbortController().signal,
    );
    await new Promise((res) => setTimeout(res, 80));
    h.killAgent();
    await expect(p).rejects.toMatchObject({ code: "interrupted" });
    expect(r.events.find((e) => e.type === "turn.interrupted")).toMatchObject({ resumable: true });
    expect(h.prompts()).toBe(1);
  });

  it("re-attaching to a session still alive in the agent skips session/load", async () => {
    const h = await startHarness();
    const r1 = recorder();
    const deps = { connect: () => connectWebSocket({ url: h.url, token: token() }), adapter: new KiroV3Adapter(), viaGateway: true };
    const first = await runAcpTurn(deps, { requestKey: "r1", messageId: "m1", session, prompt: [{ type: "text", text: "one" }] }, { ...r1, decidePermission: allowOnce }, new AbortController().signal);
    const r2 = recorder();
    const second = await runAcpTurn(deps, { requestKey: "r2", messageId: "m2", sessionId: first.sessionId, session, prompt: [{ type: "text", text: "two" }] }, { ...r2, decidePermission: allowOnce }, new AbortController().signal);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.createdSession).toBe(false);
    expect(foldTranscript(r2.events).assistantText).toBe("You said: two. ");
  });

  it("exposes status for the computer manager", async () => {
    const h = await startHarness();
    const st = h.gateway.status();
    expect(st.ready).toBe(true);
    expect(st.agentPid).toBe(4242);
    expect(h.gateway.metrics()).toContain("orrery_gateway_ready 1");
  });
});

void memoryTransportPair;
