import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadEnv, signToken, type Env } from "@orrery/core";
import { PgListener, approvals, events, runs, threads, type Db } from "@orrery/db";
import { MemoryService } from "@orrery/memory";
import { KnowledgeService } from "@orrery/rag";
import { ProviderRegistry } from "@orrery/providers";
import { createLogger } from "@orrery/observability";
import { MCP_TOKEN_AUDIENCE } from "@orrery/tools";
import { createTestDb, hasTestDb, startFakeModelServer, type FakeServers } from "@orrery/testkit";
import { Authenticator, Delivery, EventHub, RecordingWorkflowGateway, createApp, createNodeServer } from "../src/index.js";

const TOKEN = "test-dev-token-0123456789";
const ADMIN = "admin-token-0123456789-0123456789-0123456789";
const run = hasTestDb() ? describe : describe.skip;

run("orrery api", () => {
  let fake: FakeServers;
  let tdb: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;
  let env: Env;
  let wf: RecordingWorkflowGateway;
  let listener: PgListener;
  let hub: EventHub;
  let server: Server;
  let base: string;
  let memory: MemoryService;
  let knowledge: KnowledgeService;
  let delivery: Delivery;

  const call = async (method: string, path: string, body?: unknown, token = TOKEN) => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    return { status: r.status, json: text ? (JSON.parse(text) as any) : null };
  };

  const botBody = {
    name: "Ada",
    instructions: "You are Ada, the platform team's on-call teammate.",
    primary: { kind: "kiro-acp", engine: "v3" },
    routing: { mode: "auto", fast: { kind: "openai", providerId: "local", model: "fake-small" } },
    memory: { coreMemoryCharLimit: 400 },
  };

  beforeAll(async () => {
    fake = await startFakeModelServer({ dims: 64 });
    tdb = await createTestDb({ vectorDims: 64 });
    db = tdb.db;
    env = loadEnv({
      NODE_ENV: "test",
      DATABASE_URL: tdb.url,
      DEV_AUTH_TOKEN: TOKEN,
      ADMIN_TOKEN: ADMIN,
      ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      MCP_TOKEN_SECRET: "test-mcp-secret-0123456789abcdef",
      PUBLIC_BASE_URL: "http://localhost:8080",
    } as NodeJS.ProcessEnv);
    const providers = new ProviderRegistry([
      {
        kind: "openai",
        id: "local",
        baseUrl: `${fake.url}/v1`,
        headers: {},
        timeoutMs: 10_000,
        roles: ["chat", "fast", "extract", "embed", "rerank"],
        models: { chat: ["fake-small"], embed: "fake-embed", rerank: "fake-rerank" },
        capabilities: { tools: true, vision: false, jsonSchema: true },
        rerankPath: "/rerank",
      },
      { kind: "clef", id: "clef", format: "systemone", baseUrl: fake.url, model: "clef", fastModel: "clef-flash", timeoutMs: 5000 },
    ]);
    memory = new MemoryService(db, providers, 64);
    knowledge = new KnowledgeService(db, providers, 64);
    wf = new RecordingWorkflowGateway();
    listener = new PgListener(tdb.url);
    await listener.start();
    hub = new EventHub(db, listener);
    await hub.start();
    const log = createLogger("api-test", "silent");
    delivery = new Delivery(db, wf, log, { attemptTimeoutMs: 500 });
    const auth = new Authenticator(env, db);
    const { app } = createApp({ env, log, db, delivery, auth, workflows: wf, memory, knowledge, providers, hub, telemetry: null });
    server = createNodeServer(app, { env, db, memory, knowledge, workflows: wf, log, auth, delivery });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise((r) => server?.close(r));
    hub?.stop();
    await listener?.close();
    await tdb?.drop();
    await fake?.close();
  });

  it("serves health, readiness and an OpenAPI 3.1 document", async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    const doc = (await (await fetch(`${base}/openapi.json`)).json()) as { openapi: string; paths: Record<string, Record<string, unknown>> };
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(["/v1/bots", "/v1/threads/{id}/messages", "/v1/approvals/{id}/decide", "/v1/threads/{id}/events"]));
    expect(Object.keys(doc.paths).length).toBeGreaterThan(40);
  });

  it("enforces authentication and role-based access", async () => {
    expect((await call("GET", "/v1/bots", undefined, "nope")).status).toBe(401);
    expect((await fetch(`${base}/v1/bots`)).status).toBe(401);
    const viewer = await call("POST", "/v1/bots", botBody, `${TOKEN}:viewer`);
    expect(viewer.status).toBe(403);
    expect(viewer.json.error.code).toBe("forbidden");
    expect((await call("GET", "/v1/bots", undefined, `${TOKEN}:viewer`)).status).toBe(200);
  });

  it("validates input with structured errors", async () => {
    const r = await call("POST", "/v1/bots", { name: "" });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("bad_request");
    const unknownProvider = await call("POST", "/v1/bots", { ...botBody, routing: { mode: "auto", fast: { kind: "openai", providerId: "missing", model: "x" } } });
    expect(unknownProvider.status).toBe(400);
  });

  let botId: string;
  let threadId: string;

  it("creates a bot with defaults, schedules and a persona core-memory block", async () => {
    const r = await call("POST", "/v1/bots", botBody);
    expect(r.status).toBe(201);
    botId = r.json.bot.id;
    expect(botId).toMatch(/^bot_/);
    expect(r.json.bot.policy.rules.length).toBeGreaterThan(3);
    expect(r.json.bot.primary).toMatchObject({ kind: "kiro-acp", engine: "v3" });
    expect(wf.calls).toContainEqual({ op: "ensureBotSchedules", args: [botId] });
    const core = await call("GET", `/v1/bots/${botId}/core-memory`);
    expect(core.json.persona).toContain("You are Ada");
    const got = await call("GET", `/v1/bots/${botId}`);
    expect(got.json.state).toMatchObject({ botId, paused: false });
  });

  it("pauses through PATCH and signals the bot workflow", async () => {
    await call("PATCH", `/v1/bots/${botId}`, { status: "paused" });
    expect(wf.calls).toContainEqual({ op: "setPaused", args: [botId, "team_dev", true] });
    await call("PATCH", `/v1/bots/${botId}`, { status: "active" });
    expect(wf.calls).toContainEqual({ op: "setPaused", args: [botId, "team_dev", false] });
  });

  it("sends messages: persists, delivers to the bot workflow, and steers active runs", async () => {
    const t = await call("POST", `/v1/bots/${botId}/threads`, { title: "Deploy help" });
    expect(t.status).toBe(201);
    threadId = t.json.thread.id;

    const m = await call("POST", `/v1/threads/${threadId}/messages`, { text: "Why is staging red?" });
    expect(m.status).toBe(202);
    expect(m.json.mode).toBe("queue");
    const delivered = wf.calls.filter((c) => c.op === "deliver").at(-1)!.args[0] as Record<string, unknown>;
    expect(delivered).toMatchObject({ messageId: m.json.messageId, threadId, botId, teamId: "team_dev", channel: "web", parts: [{ type: "text", text: "Why is staging red?" }] });

    // steer with no active run degrades to queue
    const s0 = await call("POST", `/v1/threads/${threadId}/messages`, { text: "also check prod", mode: "steer" });
    expect(s0.json.mode).toBe("queue");

    // with an active run, steering goes to the run (no new turn)
    await runs.start(db, { id: "run_active1", teamId: "team_dev", botId, threadId, triggerMessageId: m.json.messageId, provider: "kiro-acp", workflowId: "turn:run_active1" });
    const before = wf.calls.filter((c) => c.op === "deliver").length;
    const s1 = await call("POST", `/v1/threads/${threadId}/messages`, { text: "focus on the api pods", mode: "steer" });
    expect(s1.json).toMatchObject({ mode: "steer", runId: "run_active1" });
    expect(wf.calls.filter((c) => c.op === "deliver").length).toBe(before);
    const pending = await db.query("SELECT parts FROM steering WHERE run_id = 'run_active1'");
    expect(pending.rows[0].parts).toEqual([{ type: "text", text: "focus on the api pods" }]);

    const list = await call("GET", `/v1/threads/${threadId}/messages`);
    expect(list.json.messages.map((x: any) => x.parts[0].text)).toEqual(["Why is staging red?", "also check prod", "focus on the api pods"]);
    expect((await call("GET", "/v1/runs/active")).json.runs.map((r: any) => r.id)).toContain("run_active1");
    expect((await call("POST", "/v1/runs/run_active1/cancel")).json.cancelled).toBe(true);
  });

  it("never loses a message when the workflow engine is down (transactional outbox)", async () => {
    wf.unavailable = true;
    const r = await call("POST", `/v1/threads/${threadId}/messages`, { text: "are you there?" });
    expect(r.status).toBe(202);
    expect(r.json.delivery).toBe("pending");
    const pending = await db.query("SELECT inbound, attempts FROM delivery_outbox WHERE message_id = $1", [r.json.messageId]);
    expect(pending.rows[0].attempts).toBe(1);
    expect(pending.rows[0].inbound).toMatchObject({ messageId: r.json.messageId, threadId, botId });

    wf.unavailable = false;
    await db.query("UPDATE delivery_outbox SET next_attempt_at = now(), created_at = now() - interval '1 minute'");
    expect(await delivery.tick()).toBe(1);
    expect((await db.query("SELECT count(*)::int AS n FROM delivery_outbox")).rows[0].n).toBe(0);
    const delivered = wf.calls.filter((c) => c.op === "deliver").at(-1)!.args[0] as Record<string, unknown>;
    expect(delivered).toMatchObject({ messageId: r.json.messageId, parts: [{ type: "text", text: "are you there?" }] });
  });

  it("decides approvals strictly from offered options, once, and signals the turn", async () => {
    const options = [
      { optionId: "allow", name: "Yes", kind: "allow_once" },
      { optionId: "always", name: "Always", kind: "allow_always" },
      { optionId: "deny", name: "No", kind: "reject_once" },
    ];
    await approvals.create(db, {
      id: "apr_1",
      teamId: "team_dev",
      botId,
      threadId,
      runId: "run_active1",
      toolCallId: "tc_1",
      title: "kubectl rollout restart deploy/api",
      kind: "execute",
      capability: "shell",
      resource: "kubectl rollout restart deploy/api",
      rawInput: { command: "kubectl rollout restart deploy/api" },
      options: options as never,
      consent: null,
      mcpTool: null,
      risk: 0.7,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect((await call("GET", "/v1/approvals")).json.approvals.map((a: any) => a.id)).toEqual(["apr_1"]);
    expect((await call("POST", "/v1/approvals/apr_1/decide", { optionId: "made-up" })).status).toBe(400);
    expect((await call("POST", "/v1/approvals/apr_1/decide", { optionId: "always" }, `${TOKEN}:member`)).status).toBe(403);
    const ok = await call("POST", "/v1/approvals/apr_1/decide", { optionKind: "allow_once" }, `${TOKEN}:member`);
    expect(ok.status).toBe(200);
    expect(ok.json.approval).toMatchObject({ status: "approved", decision: { optionId: "allow", optionKind: "allow_once", by: "usr_dev_member" } });
    expect(wf.calls).toContainEqual({ op: "signalApproval", args: ["run_active1", { approvalId: "apr_1", optionId: "allow", optionKind: "allow_once", cancelled: false, actor: "usr_dev_member" }] });
    const again = await call("POST", "/v1/approvals/apr_1/decide", { optionId: "deny" });
    expect(again.status).toBe(409);
    const audit = await call("GET", "/v1/audit");
    expect(audit.json.entries.some((e: any) => e.action === "approval.decide" && e.target === "apr_1")).toBe(true);
  });

  it("memory: teach, recall, edit, pin, forget", async () => {
    const w = await call("POST", "/v1/memories", { botId, kind: "fact", content: "Remember that staging runs in eu-north-1 on EKS" });
    expect(w.status).toBe(201);
    expect(w.json.result.action).toBe("created");
    const id = w.json.result.id;
    const secret = await call("POST", "/v1/memories", { botId, kind: "fact", content: "the prod password is hunter2-ABCD-1234" });
    expect(secret.json.result).toMatchObject({ action: "skipped", reason: "sensitive" });
    const s = await call("POST", "/v1/memories/search", { botId, query: "where does staging run?" });
    expect(s.json.results[0].content).toContain("eu-north-1");
    const p = await call("PATCH", `/v1/memories/${id}`, { pinned: true, importance: 0.9 });
    expect(p.json.memory).toMatchObject({ pinned: true, importance: 0.9 });
    expect((await call("GET", `/v1/memories?botId=${botId}`)).json.memories.length).toBe(1);
    expect((await call("DELETE", `/v1/memories/${id}`)).status).toBe(200);
    expect((await call("GET", `/v1/memories?botId=${botId}`)).json.memories.length).toBe(0);
    expect((await call("DELETE", `/v1/memories/${id}?purge=true`, undefined, `${TOKEN}:member`)).status).toBe(403);
  });

  it("knowledge: create a base, add text and upload sources, start ingestion, search", async () => {
    const kb = await call("POST", "/v1/knowledge-bases", { name: "Runbooks" });
    expect(kb.status).toBe(201);
    const kbId = kb.json.knowledgeBase.id;
    const src = await call("POST", `/v1/knowledge-bases/${kbId}/sources`, { type: "text", title: "Staging runbook", text: "# Staging\n\nStaging deploys run through ArgoCD. To restart the api, sync the api app in ArgoCD." });
    expect(src.status).toBe(201);
    expect(wf.calls).toContainEqual({ op: "startIngest", args: [src.json.source.id] });

    const form = new FormData();
    form.set("file", new File(["Incidents are declared in #incidents with /incident new."], "incidents.md", { type: "text/markdown" }));
    const up = await fetch(`${base}/v1/knowledge-bases/${kbId}/sources`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: form });
    expect(up.status).toBe(201);
    const upSrc = ((await up.json()) as any).source;
    expect(upSrc).toMatchObject({ type: "upload", title: "incidents.md" });

    // the recording gateway doesn't run workflows; ingest directly like the worker would
    await knowledge.ingestSource(src.json.source.id);
    await knowledge.ingestSource(upSrc.id);
    const sources = await call("GET", `/v1/knowledge-bases/${kbId}/sources`);
    expect(sources.json.sources.every((x: any) => x.status === "ready")).toBe(true);
    const res = await call("POST", "/v1/knowledge/search", { knowledgeBaseIds: [kbId], query: "how do I restart the api on staging?" });
    expect(res.json.hits[0].content).toContain("ArgoCD");
  });

  it("routines: create, update, run now, delete — mirrored to Temporal schedules", async () => {
    const r = await call("POST", "/v1/routines", { botId, name: "Morning triage", prompt: "Summarize overnight alerts", schedule: { cron: "0 7 * * 1-5", timezone: "Europe/Helsinki" } });
    expect(r.status).toBe(201);
    const id = r.json.routine.id;
    expect(wf.calls).toContainEqual({ op: "upsertRoutine", args: [id] });
    expect((await call("PATCH", `/v1/routines/${id}`, { enabled: false })).json.routine.enabled).toBe(false);
    await call("POST", `/v1/routines/${id}/run`);
    expect(wf.calls).toContainEqual({ op: "triggerRoutine", args: [id] });
    await call("DELETE", `/v1/routines/${id}`);
    expect(wf.calls).toContainEqual({ op: "deleteRoutine", args: [id] });
  });

  it("secrets are write-only and encrypted at rest", async () => {
    expect((await call("PUT", "/v1/secrets/github-token", { value: "ghp_example_value" })).status).toBe(200);
    const list = await call("GET", "/v1/secrets");
    expect(JSON.stringify(list.json)).not.toContain("ghp_example_value");
    expect(list.json.secrets.map((s: any) => s.name)).toContain("github-token");
    const raw = await db.query("SELECT * FROM secrets");
    expect(JSON.stringify(raw.rows)).not.toContain("ghp_example_value");
    expect((await call("GET", "/v1/secrets", undefined, `${TOKEN}:member`)).status).toBe(403);
  });

  it("inbound webhooks start turns with a bot-scoped token", async () => {
    const tok = await call("GET", `/v1/bots/${botId}/webhook-token`);
    const r = await fetch(`${base}/v1/hooks/bots/${botId}`, { method: "POST", headers: { authorization: `Bearer ${tok.json.token}`, "content-type": "application/json" }, body: JSON.stringify({ text: "PagerDuty: api p99 > 2s", source: "pagerduty" }) });
    expect(r.status).toBe(202);
    const body = (await r.json()) as { threadId: string };
    const delivered = wf.calls.filter((c) => c.op === "deliver").at(-1)!.args[0] as Record<string, unknown>;
    expect(delivered).toMatchObject({ threadId: body.threadId, channel: "webhook", author: { type: "system", id: "webhook:pagerduty" } });
    const bad = await fetch(`${base}/v1/hooks/bots/${botId}`, { method: "POST", headers: { authorization: "Bearer x.y", "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) });
    expect(bad.status).toBe(401);
  });

  it("streams run events over SSE with backlog and live delivery", async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/v1/threads/${threadId}/events`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: ctrl.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const readUntil = async (pred: (s: string) => boolean) => {
      const deadline = Date.now() + 5000;
      while (!pred(buf)) {
        if (Date.now() > deadline) throw new Error(`timeout; got: ${buf}`);
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
      }
    };
    await readUntil((s) => s.includes("event: ready"));
    await events.append(db, [
      { runId: "run_active1", seq: 1, teamId: "team_dev", botId, threadId, event: { type: "message.delta", messageId: "msg_a", part: { type: "text", text: "Looking at " } } },
      { runId: "run_active1", seq: 2, teamId: "team_dev", botId, threadId, event: { type: "message.delta", messageId: "msg_a", part: { type: "text", text: "the api pods" } } },
    ]);
    await readUntil((s) => s.includes("the api pods"));
    const ids = [...buf.matchAll(/^id: (.+)$/gm)].map((m) => m[1]);
    expect(ids.some((i) => i!.endsWith("|run_active1:2"))).toBe(true);
    ctrl.abort();

    // reconnect with Last-Event-ID → only newer events replayed
    const lastId = ids.find((i) => i!.endsWith(":1"))!;
    await events.append(db, [{ runId: "run_active1", seq: 3, teamId: "team_dev", botId, threadId, event: { type: "turn.completed", stopReason: "end_turn" } }]);
    const backlog = await hub.backlog(threadId, lastId);
    expect(backlog.map((e) => e.seq)).toEqual([2, 3]);
  });

  it("exposes platform tools to agents over MCP with a bot-scoped token", async () => {
    const token = signToken({ sub: botId, aud: MCP_TOKEN_AUDIENCE, exp: Math.floor(Date.now() / 1000) + 600, team: "team_dev", thread: threadId, user: "usr_dev" }, env.MCP_TOKEN_SECRET);
    const client = new McpClient({ name: "kiro-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["memory_search", "memory_save", "core_memory_append", "conversation_history"]));
    expect(tools).not.toContain("bots_delegate"); // no peers configured
    const saved = await client.callTool({ name: "memory_save", arguments: { content: "The on-call rotation changes every Monday at 09:00", kind: "fact" } });
    expect(JSON.stringify(saved.content)).toMatch(/created|saved/i);
    const found = await client.callTool({ name: "memory_search", arguments: { query: "when does on-call rotate?" } });
    expect(JSON.stringify(found.content)).toContain("Monday");
    const hist = await client.callTool({ name: "conversation_history", arguments: { limit: 5 } });
    expect(JSON.stringify(hist.content)).toContain("staging");
    await client.close();

    const denied = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(denied.status).toBe(401);
  });

  it("signs in with the admin token and API tokens; revoked tokens stop working", async () => {
    const me = await call("GET", "/v1/me", undefined, ADMIN);
    expect(me.json).toMatchObject({ role: "owner", via: "admin-token", teamId: "team_default" });
    const created = await call("POST", "/v1/tokens", { name: "laptop", role: "member", forUser: { name: "Alice" } }, ADMIN);
    expect(created.status).toBe(201);
    const token = created.json.token as string;
    expect(token).toMatch(/^orr_[A-Za-z0-9_-]{40,}$/);
    const alice = await call("GET", "/v1/me", undefined, token);
    expect(alice.json).toMatchObject({ role: "member", name: "Alice", via: "api-token", teamId: "team_default" });
    // a member cannot mint an admin token
    expect((await call("POST", "/v1/tokens", { name: "x", role: "admin" }, token)).status).toBe(403);
    const list = await call("GET", "/v1/tokens", undefined, ADMIN);
    expect(list.json.tokens[0]).toMatchObject({ name: "laptop", userName: "Alice", prefix: token.slice(0, 10) });
    expect(JSON.stringify(list.json)).not.toContain(token);
    expect((await call("DELETE", `/v1/tokens/${created.json.apiToken.id}`, undefined, ADMIN)).status).toBe(200);
    expect((await call("GET", "/v1/me", undefined, token)).status).toBe(401);
  });

  it("stores agent credentials write-only and reports setup status", async () => {
    expect((await call("PUT", "/v1/agent-env/ANTHROPIC_API_KEY", { value: "sk-ant-test" })).status).toBe(200);
    expect((await call("PUT", "/v1/agent-env/lowercase", { value: "x" })).status).toBe(400);
    expect((await call("PUT", "/v1/agent-env/LD_PRELOAD", { value: "/tmp/x.so" })).status).toBe(400);
    const vars = await call("GET", "/v1/agent-env");
    expect(vars.json.variables.map((v: any) => v.name)).toEqual(["ANTHROPIC_API_KEY"]);
    expect(JSON.stringify(vars.json)).not.toContain("sk-ant-test");
    expect((await call("GET", "/v1/secrets")).json.secrets.map((x: any) => x.name)).not.toContain("agent-env.ANTHROPIC_API_KEY");
    const setup = await call("GET", "/v1/setup");
    expect(setup.json).toMatchObject({ computers: "local", agentEnv: ["ANTHROPIC_API_KEY"], engines: { opencode: "configured" }, auth: { adminToken: true } });
    expect(setup.json.engines.kiro).toMatch(/needs KIRO_API_KEY/);
  });

  let groupThread: string;
  let groupId: string;
  let scoutId: string;

  it("routes group messages to mentioned bots, or the lead", async () => {
    scoutId = (await call("POST", "/v1/bots", { ...botBody, name: "Scout", routing: { mode: "fixed" } })).json.bot.id;
    const quill = (await call("POST", "/v1/bots", { ...botBody, name: "Release Bot", routing: { mode: "fixed" } })).json.bot.id;
    const g = await call("POST", "/v1/groups", { name: "incidents", topic: "On-call", botIds: [botId, scoutId, quill] });
    expect(g.status).toBe(201);
    groupId = g.json.group.id;
    groupThread = g.json.group.threadId;
    expect(g.json.group.members.map((m: any) => [m.name, m.lead])).toEqual([["Ada", true], ["Scout", false], ["Release Bot", false]]);
    expect((await call("POST", "/v1/groups", { name: "Incidents", botIds: [botId] })).status).toBe(409);

    const delivered = () => wf.calls.filter((c) => c.op === "deliver").map((c) => c.args[0] as any);
    const before = delivered().length;
    const r1 = await call("POST", `/v1/groups/${groupId}/messages`, { text: "payments look slow" });
    expect(r1.json.targets).toEqual([botId]);
    const r2 = await call("POST", `/v1/threads/${groupThread}/messages`, { text: "@scout check the dashboards, then @Release Bot hold the deploy" });
    expect(r2.json.targets).toEqual([scoutId, quill]);
    const r3 = await call("POST", `/v1/groups/${groupId}/messages`, { text: "@all stand down" });
    expect(r3.json.targets).toHaveLength(3);
    const sent = delivered().slice(before);
    expect(sent.map((m) => m.botId)).toEqual([botId, scoutId, quill, botId, scoutId, quill]);
    expect(sent.every((m) => m.channel === "group" && m.threadId === groupThread && m.hops === 0)).toBe(true);
    // one stored message per post, shared by every bot it went to
    expect(new Set(sent.slice(1, 3).map((m) => m.messageId)).size).toBe(1);
    const msgs = await call("GET", `/v1/threads/${groupThread}/messages`);
    expect(msgs.json.messages).toHaveLength(3);
    // group threads are not listed among a bot's own conversations
    expect((await call("GET", `/v1/bots/${botId}/threads`)).json.threads.map((t: any) => t.id)).not.toContain(groupThread);
    expect((await call("GET", "/v1/groups")).json.groups.map((x: any) => x.name)).toEqual(["incidents"]);
  });

  it("gives people an MCP tool set with their own token", async () => {
    const minted = await call("POST", "/v1/tokens", { name: "mcp" });
    const client = new McpClient({ name: "desktop-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${minted.json.token}` } } }));
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["list_bots", "ask_bot", "wait_for_reply", "get_conversation", "list_approvals", "decide_approval", "list_groups"]));
    expect(tools).not.toContain("memory_save"); // platform tools are for agents
    const listed = await client.callTool({ name: "list_bots", arguments: {} });
    expect(JSON.stringify(listed.content)).toContain("Scout");
    const groupsListed = await client.callTool({ name: "list_groups", arguments: {} });
    expect(JSON.stringify(groupsListed.structuredContent)).toContain("incidents");
    // ask without waiting: the message is delivered and the call returns the conversation
    const before = wf.calls.filter((c) => c.op === "deliver").length;
    const asked = await client.callTool({ name: "ask_bot", arguments: { bot: "scout", message: "status?", wait_seconds: 0 } });
    expect(asked.isError).toBeFalsy();
    const out = asked.structuredContent as { conversation_id: string; status: string };
    expect(out.conversation_id).toMatch(/^thr_/);
    expect(out.status).toBe("running");
    const d = wf.calls.filter((c) => c.op === "deliver").slice(before).map((c) => c.args[0] as any);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ botId: scoutId, channel: "api" });
    const conv = await client.callTool({ name: "get_conversation", arguments: { conversation_id: out.conversation_id } });
    expect(JSON.stringify(conv.content)).toContain("status?");
    const bad = await client.callTool({ name: "ask_bot", arguments: { bot: "nobody", message: "hi", wait_seconds: 0 } });
    expect(bad.isError).toBe(true);
    await client.close();
  });

  it("archives threads and bots", async () => {
    await call("DELETE", `/v1/threads/${threadId}`);
    expect((await threads.get(db, "team_dev", threadId))?.archived).toBe(true);
    await call("DELETE", `/v1/bots/${botId}`);
    expect((await call("GET", "/v1/bots")).json.bots.map((b: any) => b.id)).not.toContain(botId);
  });
});
