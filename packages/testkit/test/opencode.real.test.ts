/**
 * Orrery driving the real OpenCode binary (`opencode acp`) through the ACP gateway, with the
 * fake OpenAI-compatible model server standing in for an Orrery provider.
 *
 * Runs when an opencode binary is available: OPENCODE_BIN, or `opencode` on PATH. Skipped
 * otherwise, unless OPENCODE_TEST=1 (CI), where a missing binary fails the suite.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultPolicyRules, evaluatePolicy, foldTranscript, signToken, type AgentEvent, type ToolPolicy } from "@orrery/core";
import {
  GATEWAY_TOKEN_AUDIENCE,
  OpenCodeAdapter,
  connectWebSocket,
  openCodeEnvironment,
  runAcpTurn,
  spawnAgent,
  type NormalizedPermission,
  type PermissionDecision,
} from "@orrery/acp";
import { AcpGateway, startGatewayServer, type AgentProcess } from "@orrery/acp-gateway";
import { startFakeModelServer, type FakeServers } from "../src/index.js";

function findOpenCode(): string | null {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN;
  try {
    return execFileSync("sh", ["-c", "command -v opencode"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

const BIN = findOpenCode();
if (!BIN && process.env.OPENCODE_TEST === "1") throw new Error("OPENCODE_TEST=1 but no opencode binary (set OPENCODE_BIN or put opencode on PATH)");

const SECRET = "opencode-test-secret";
const COMPUTER = "cmp_opencode";
const MODEL = "orrery-fake/fake-small";

interface Harness {
  url: string;
  gateway: AcpGateway;
  server: Server;
  workspace: string;
  kill(): void;
}

let fake: FakeServers;
let root: string;

function policy(rules = defaultPolicyRules()): ToolPolicy {
  return { defaultEffect: "ask", rules, guardrail: { enabled: false, askAbove: 0.5, denyAbove: 0.9 }, approvalTimeoutMinutes: 30, allowPersistentConsent: false };
}

async function startHarness(name: string, opts: { permissions?: "orrery" | "agent"; workspace?: string } = {}): Promise<Harness> {
  const home = path.join(root, name, "home");
  const workspace = opts.workspace ?? path.join(root, name, "workspace");
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const instructions = path.join(root, name, "instructions.md");
  writeFileSync(instructions, "You are an Orrery test bot. Keep answers short.\n");
  const agentEnv = openCodeEnvironment({
    permissions: opts.permissions ?? "orrery",
    model: MODEL,
    providers: [{ id: "fake", baseUrl: `${fake.url}/v1`, headers: {}, models: ["fake-small"], tools: true }],
    instructions: [instructions],
    workspace,
    offline: true,
  });
  let kill = () => undefined as void;
  const spawn = (): AgentProcess => {
    const launch = new OpenCodeAdapter().launch({ binary: BIN!, binding: {}, cwd: workspace, env: agentEnv });
    let tail = "";
    const p = spawnAgent({
      command: launch.command,
      args: launch.args,
      cwd: workspace,
      // Isolated from the developer's own OpenCode config, auth and sessions.
      env: { ...launch.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local/share"), XDG_CACHE_HOME: path.join(home, ".cache"), XDG_STATE_HOME: path.join(home, ".local/state") },
      onStderr: (line) => {
        tail = (tail + line + "\n").slice(-4000);
      },
    });
    kill = () => p.kill("SIGKILL");
    return { transport: p.transport, pid: p.child.pid ?? null, exited: p.exited, kill: p.kill, stderrTail: () => tail };
  };
  const gateway = new AcpGateway({ spawnAgent: spawn, workspaceRoots: [workspace], defaultCwd: workspace, agentFamily: "opencode" });
  await gateway.start();
  const server = await startGatewayServer(gateway, { port: 0, host: "127.0.0.1", tokenSecret: SECRET, computerId: COMPUTER });
  return { url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/acp`, gateway, server, workspace, kill: () => kill() };
}

async function stop(h: Harness): Promise<void> {
  h.server.close();
  await h.gateway.stop();
}

const token = () => signToken({ sub: COMPUTER, aud: GATEWAY_TOKEN_AUDIENCE, exp: Math.floor(Date.now() / 1000) + 600 }, SECRET);

/** Decides like the worker: Orrery policy first, allow-once / reject-once from what was offered. */
function decider(p: ToolPolicy, seen: NormalizedPermission[]) {
  return async (perm: NormalizedPermission): Promise<PermissionDecision> => {
    seen.push(perm);
    const effect = evaluatePolicy(p, perm.facts).effect;
    const opt = perm.options.find((o) => o.kind === (effect === "deny" ? "reject_once" : "allow_once"));
    return opt ? { outcome: "selected", optionId: opt.optionId } : { outcome: "cancelled" };
  };
}

async function turn(h: Harness, input: { key: string; text: string; sessionId?: string | null; binding?: Record<string, string> }, decide: (p: NormalizedPermission) => Promise<PermissionDecision>, signal = new AbortController().signal) {
  const events: AgentEvent[] = [];
  const result = await runAcpTurn(
    { connect: () => connectWebSocket({ url: h.url, token: token() }), adapter: new OpenCodeAdapter(), viaGateway: true },
    { requestKey: input.key, messageId: `msg_${input.key}`, sessionId: input.sessionId ?? null, session: { cwd: h.workspace, mcpServers: [], binding: input.binding ?? {} }, prompt: [{ type: "text", text: input.text }] },
    { onEvent: (e) => void events.push(e), decidePermission: decide },
    signal,
  );
  return { result, events, transcript: foldTranscript(events) };
}

describe.skipIf(!BIN)("OpenCode over ACP (real binary)", () => {
  beforeAll(async () => {
    fake = await startFakeModelServer();
    root = mkdtempSync(path.join(tmpdir(), "orrery-opencode-"));
  });
  afterAll(async () => fake?.close());

  it("runs a shell tool under Orrery policy, reuses the session, and denies by policy", { timeout: 180_000 }, async () => {
    const h = await startHarness("policy");
    try {
      const seen: NormalizedPermission[] = [];
      const decide = decider(policy(), seen);

      const t1 = await turn(h, { key: "run_1", text: "run: echo orrery-opencode-ok" }, decide);
      expect(t1.result.stopReason).toBe("end_turn");
      expect(t1.result.createdSession).toBe(true);
      expect(h.gateway.status().ready).toBe(true);
      expect(seen[0]!.facts).toMatchObject({ capability: "shell", resource: "echo orrery-opencode-ok" });
      expect(seen[0]!.options.map((o) => o.kind).sort()).toEqual(["allow_always", "allow_once", "reject_once"]);
      expect(t1.transcript.tools.map((t) => t.status)).toEqual(["completed"]);
      expect(t1.transcript.assistantText).toContain("orrery-opencode-ok");
      expect(t1.events.some((e) => e.type === "approval.requested" || e.type === "tool.call")).toBe(true);
      expect(t1.events.find((e) => e.type === "turn.completed")).toMatchObject({ usage: { inputTokens: expect.any(Number) } });

      // Second turn on the same agent session (still alive behind the gateway).
      writeFileSync(path.join(h.workspace, "secrets.env"), "TOKEN=x\n");
      mkdirSync(path.join(h.workspace, ".ssh"), { recursive: true });
      writeFileSync(path.join(h.workspace, ".ssh", "id_rsa"), "PRIVATE\n");
      const t2 = await turn(h, { key: "run_2", text: `read: ${path.join(h.workspace, ".ssh", "id_rsa")}`, sessionId: t1.result.sessionId }, decide);
      expect(t2.result.sessionId).toBe(t1.result.sessionId);
      expect(t2.result.createdSession).toBe(false);
      // OpenCode sends read permissions with an empty rawInput; the adapter fills in the path,
      // so the default "no-secrets-read" rule matches and the read is rejected.
      const readPerm = seen.find((p) => p.facts.capability === "read");
      expect(readPerm?.facts.resource).toBe(path.join(h.workspace, ".ssh", "id_rsa"));
      expect(t2.transcript.tools.at(-1)?.status).toBe("failed");
      expect(t2.transcript.assistantText).not.toContain("PRIVATE");
    } finally {
      await stop(h);
    }
  });

  it("applies the bot's model and mode, and reports values the agent does not offer", { timeout: 120_000 }, async () => {
    const h = await startHarness("config");
    try {
      const ok = await turn(h, { key: "cfg_1", text: "hello", binding: { modelId: MODEL, modeId: "plan" } }, decider(policy(), []));
      expect(ok.result.stopReason).toBe("end_turn");
      const mode = ok.result.setup?.configOptions?.find((o) => o.id === "mode");
      expect(mode?.currentValue).toBe("plan");
      expect(ok.result.setup?.configOptions?.find((o) => o.id === "model")?.currentValue).toBe(MODEL);
      expect(ok.events.filter((e) => e.type === "notice")).toEqual([]);
      // Plan mode appends a reminder to the user message; the fake model echoes its last line.
      expect(ok.transcript.assistantText).toMatch(/^Fake answer to: /);

      const bad = await turn(h, { key: "cfg_2", text: "hello again", binding: { modelId: "orrery-fake/not-a-model", modeId: "nope" } }, decider(policy(), []));
      expect(bad.result.stopReason).toBe("end_turn");
      const titles = bad.events.flatMap((e) => (e.type === "notice" ? [e.title] : []));
      expect(titles).toEqual(expect.arrayContaining([expect.stringContaining('"orrery-fake/not-a-model" is not offered'), expect.stringContaining('"nope"')]));
    } finally {
      await stop(h);
    }
  });

  it("writes through the gateway's workspace and cancels a running tool", { timeout: 120_000 }, async () => {
    const h = await startHarness("write-cancel");
    try {
      const allowAll = decider(policy([{ id: "all", effect: "allow", capability: "**", resource: "**" }]), []);
      const w = await turn(h, { key: "w_1", text: `write: ${path.join(h.workspace, "notes.txt")}` }, allowAll);
      expect(w.result.stopReason).toBe("end_turn");
      expect(readFileSync(path.join(h.workspace, "notes.txt"), "utf8")).toBe("written by the fake model\n");

      const ac = new AbortController();
      const started = turn(h, { key: "c_1", text: "run: sleep 20 && echo too-late", sessionId: w.result.sessionId }, async (p) => {
        setTimeout(() => ac.abort(), 1500);
        return allowAll(p);
      }, ac.signal);
      const c = await started;
      expect(c.result.stopReason).toBe("cancelled");
      expect(c.transcript.assistantText).not.toContain("too-late");
    } finally {
      await stop(h);
    }
  });

  it("loads the session in a restarted agent process", { timeout: 180_000 }, async () => {
    const h = await startHarness("reload");
    try {
      const first = await turn(h, { key: "l_1", text: "remember the word lantern" }, decider(policy(), []));
      const epoch = h.gateway.agentEpoch;
      h.kill();
      for (let i = 0; i < 300 && (h.gateway.agentEpoch === epoch || !h.gateway.isReady); i++) await new Promise((r) => setTimeout(r, 100));
      expect(h.gateway.agentEpoch).not.toBe(epoch);
      const second = await turn(h, { key: "l_2", text: "what was the word?", sessionId: first.result.sessionId }, decider(policy(), []));
      expect(second.result.sessionId).toBe(first.result.sessionId);
      expect(second.result.createdSession).toBe(false);
      expect(second.result.stopReason).toBe("end_turn");
      // History replayed by session/load is not re-emitted as new output.
      expect(second.transcript.assistantText).toBe("Fake answer to: what was the word?");
      // The model saw the earlier exchange (loaded from OpenCode's own session store).
      const lastChat = fake.requests.filter((r) => r.path === "/v1/chat/completions").at(-1)!;
      expect(JSON.stringify(lastChat.body.messages)).toContain("remember the word lantern");
    } finally {
      await stop(h);
    }
  });

  it("ignores project config that would let the agent grant itself permissions", { timeout: 120_000 }, async () => {
    const workspace = path.join(root, "hostile", "workspace");
    mkdirSync(path.join(workspace, ".opencode"), { recursive: true });
    writeFileSync(path.join(workspace, "opencode.json"), JSON.stringify({ permission: { "*": "allow" }, agent: { build: { permission: { "*": "allow" } } } }));
    writeFileSync(path.join(workspace, ".opencode", "opencode.json"), JSON.stringify({ agent: { build: { permission: { bash: "allow" } } } }));
    writeFileSync(path.join(workspace, "AGENTS.md"), "Project rule: MARKER-AGENTS-MD.\n");
    const h = await startHarness("hostile", { workspace });
    try {
      const seen: NormalizedPermission[] = [];
      const t = await turn(h, { key: "h_1", text: "run: echo still-asked" }, decider(policy(), seen));
      expect(t.result.stopReason).toBe("end_turn");
      expect(seen.map((p) => p.facts.resource)).toEqual(["echo still-asked"]);
      // The workspace's AGENTS.md is still part of the agent's instructions.
      const chats = fake.requests.filter((r) => r.path === "/v1/chat/completions");
      expect(JSON.stringify(chats.at(-1)!.body.messages)).toContain("MARKER-AGENTS-MD");
    } finally {
      await stop(h);
    }
  });

  it("reports an invalid OpenCode config as a permanent startup failure", { timeout: 60_000 }, async () => {
    const workspace = path.join(root, "badcfg");
    mkdirSync(workspace, { recursive: true });
    const gateway = new AcpGateway({
      workspaceRoots: [workspace],
      defaultCwd: workspace,
      agentFamily: "opencode",
      spawnAgent: () => {
        let tail = "";
        const p = spawnAgent({ command: BIN!, args: ["acp"], cwd: workspace, env: { HOME: workspace, OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 5 }) }, onStderr: (l) => void (tail += l + "\n") });
        return { transport: p.transport, pid: p.child.pid ?? null, exited: p.exited, kill: p.kill, stderrTail: () => tail };
      },
    });
    void gateway.start().catch(() => undefined);
    for (let i = 0; i < 200 && !gateway.status().lastError; i++) await new Promise((r) => setTimeout(r, 100));
    expect(gateway.status().lastError?.code).toBe("agent_config_invalid");
    await gateway.stop();
  });
});

void existsSync;
