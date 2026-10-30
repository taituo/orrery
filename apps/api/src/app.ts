import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import {
  ApprovalDecisionSchema,
  BotCreateSchema,
  BotPatchSchema,
  MemoryKindSchema,
  MemoryWriteSchema,
  OrreryError,
  RoutineCreateSchema,
  RoutineScheduleSchema,
  defaultPolicyRules,
  isOrreryError,
  newId,
  nowIso,
  signToken,
  verifyToken,
  type Bot,
  type ContentPart,
  type Env,
  type InboundMessage,
  type RunEventEnvelope,
} from "@orrery/core";
import { approvals, audit, bots, computers, events, knowledge, messages, routines, runs, secrets, steering, threads, usage, withTx, type Db } from "@orrery/db";
import type { MemoryService } from "@orrery/memory";
import type { KnowledgeService } from "@orrery/rag";
import { openCodeModelProblem, type ProviderRegistry } from "@orrery/providers";
import { langfuseTraceUrl, scoreTrace, type Telemetry } from "@orrery/observability";
import type { Logger } from "pino";
import { requireRole, type Authenticator, type Principal } from "./auth.js";
import type { Delivery } from "./delivery.js";
import { OpenApiRegistry } from "./openapi.js";
import type { EventHub } from "./sse.js";
import type { WorkflowGateway } from "./workflow-gateway.js";

export interface ApiDeps {
  env: Env;
  log: Logger;
  db: Db;
  delivery: Delivery;
  auth: Authenticator;
  workflows: WorkflowGateway;
  memory: MemoryService;
  knowledge: KnowledgeService;
  providers: ProviderRegistry;
  hub: EventHub | null;
  telemetry: Telemetry | null;
}

type Vars = { principal: Principal; requestId: string };
type Ctx = Context<{ Variables: Vars }>;
type Role = Parameters<typeof requireRole>[1];

const ContentPartSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string().max(200_000) }),
  z.object({ type: z.literal("image"), mimeType: z.string(), data: z.string().max(15_000_000).optional(), uri: z.string().url().optional() }),
  z.object({ type: z.literal("resource_link"), uri: z.string(), name: z.string(), mimeType: z.string().optional(), title: z.string().optional() }),
  z.object({ type: z.literal("resource"), resource: z.object({ uri: z.string(), mimeType: z.string().optional(), text: z.string().optional(), blob: z.string().optional() }) }),
]);

const SendMessageSchema = z
  .object({
    text: z.string().min(1).max(200_000).optional(),
    parts: z.array(ContentPartSchema).max(32).optional(),
    /** queue: run as the next turn (coalesced if busy). steer: inject into the running turn. */
    mode: z.enum(["queue", "steer"]).default("queue"),
    forceProvider: z.enum(["primary", "fast"]).optional(),
  })
  .refine((b) => Boolean(b.text) !== Boolean(b.parts?.length), { message: "provide either text or parts" });

const WEBHOOK_AUDIENCE = "orrery-webhook";

/** Temporal client errors that mean "not reachable right now" (gRPC UNAVAILABLE / DEADLINE_EXCEEDED, connect failures). */
/**
 * Whether guidance can be injected into this bot's running turn. Orrery's own tool loop (OpenAI
 * bindings) and OpenCode take no mid-turn guidance, so it becomes the next turn; for Kiro and
 * generic ACP agents the worker finds out from the live session and re-queues if it cannot.
 */
function canSteer(bot: Bot, run?: { provider: string | null }): boolean {
  if (run?.provider === "openai" || run?.provider === "opencode-acp") return false;
  return bot.primary.kind === "kiro-acp" || bot.primary.kind === "acp";
}

function isTemporalUnavailable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code ?? (err.cause as { code?: unknown } | undefined)?.code;
  if (code === 14 || code === 4) return true;
  return err.name === "ServiceError" || /UNAVAILABLE|DEADLINE_EXCEEDED|Failed to connect|ECONNREFUSED/.test(err.message);
}

export function createApp(deps: ApiDeps): { app: Hono<{ Variables: Vars }>; openapi: OpenApiRegistry } {
  const { db, env, workflows, memory } = deps;
  const app = new Hono<{ Variables: Vars }>();
  const openapi = new OpenApiRegistry();

  app.use("*", secureHeaders());
  app.use("/v1/*", cors({ origin: env.WEB_ORIGINS, allowHeaders: ["authorization", "content-type", "last-event-id"], allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], maxAge: 600, credentials: false }));
  app.use("*", async (c, next) => {
    c.set("requestId", c.req.header("x-request-id") ?? newId("event"));
    await next();
  });

  app.onError((err, c) => {
    const e = isOrreryError(err)
      ? err
      : err instanceof z.ZodError
        ? new OrreryError("bad_request", err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "))
        : isTemporalUnavailable(err)
          ? new OrreryError("provider_unavailable", "The workflow engine is unavailable; try again shortly.", { retryable: true })
          : new OrreryError("internal", "internal error");
    if (e.code === "provider_unavailable") deps.log.warn({ err: String(err), path: c.req.path }, "dependency unavailable");
    if (e.code === "internal") deps.log.error({ err, path: c.req.path, requestId: c.get("requestId") }, "request failed");
    return c.json({ error: e.toJSON() }, e.httpStatus as 400);
  });

  app.get("/healthz", (c) => c.text("ok"));
  app.get("/readyz", async (c) => {
    try {
      await db.query("SELECT 1");
      return c.text("ready");
    } catch {
      return c.text("db unavailable", 503);
    }
  });

  /** Register an authenticated JSON route (+ OpenAPI doc). */
  function route<B = unknown, Q = unknown>(
    method: "get" | "post" | "put" | "patch" | "delete",
    path: string,
    opts: { summary: string; tag: string; role?: Role; body?: z.ZodType<B>; query?: z.ZodType<Q>; status?: number },
    handler: (c: Ctx, x: { p: Principal; body: B; query: Q }) => Promise<unknown>,
  ): void {
    openapi.add({ method, path, summary: opts.summary, tag: opts.tag, ...(opts.role ? { role: opts.role } : {}), ...(opts.body ? { body: opts.body } : {}), ...(opts.query ? { query: opts.query } : {}) });
    app[method](path, async (c) => {
      const p = await deps.auth.authenticate(c.req.header("authorization"));
      requireRole(p, opts.role ?? "viewer");
      c.set("principal", p);
      const body = opts.body ? opts.body.parse(await c.req.json().catch(() => ({}))) : (undefined as B);
      const query = opts.query ? opts.query.parse(c.req.query()) : (undefined as Q);
      const result = await handler(c as Ctx, { p, body, query });
      if (result instanceof Response) return result;
      return c.json(result ?? { ok: true }, (opts.status ?? 200) as 200);
    });
  }

  const mustBot = async (p: Principal, id: string) => {
    const b = await bots.get(db, p.teamId, id);
    if (!b) throw new OrreryError("not_found", "bot not found");
    return b;
  };
  const mustThread = async (p: Principal, id: string) => {
    const t = await threads.get(db, p.teamId, id);
    if (!t) throw new OrreryError("not_found", "thread not found");
    return t;
  };
  const mustRun = async (p: Principal, id: string) => {
    const r = await runs.get(db, p.teamId, id);
    if (!r) throw new OrreryError("not_found", "run not found");
    return r;
  };
  const log = (p: Principal, action: string, target: string | null, data: Record<string, unknown> = {}) => audit.log(db, { teamId: p.teamId, actor: p.userId, action, target, data });

  /* ---------------------------------------------------------------- me / platform */
  route("get", "/v1/me", { summary: "Current principal", tag: "platform" }, async (_c, { p }) => p);
  route("get", "/v1/providers", { summary: "Configured model providers", tag: "platform" }, async () => ({
    providers: deps.providers.describe(),
    decisions: deps.providers.decisions()?.id ?? null,
    kiro: { engines: ["v3", "v2", "auto"], defaultEngine: "v3" },
  }));
  route("post", "/v1/providers/:id/test", { summary: "Probe a provider", tag: "platform", role: "admin" }, async (c) => {
    const id = c.req.param("id")!;
    const started = Date.now();
    if (deps.providers.has(id)) {
      const models = await deps.providers.get(id).listModels().catch((e: unknown) => {
        throw new OrreryError("provider_unavailable", String(e));
      });
      return { ok: true, latencyMs: Date.now() - started, models };
    }
    const d = deps.providers.decisions();
    if (d && d.id === id) {
      const a = await d.decide("ping", { ok: { type: "noul", instructions: "Is this a ping?" } }, { fast: true });
      return { ok: true, latencyMs: Date.now() - started, answer: a.ok };
    }
    throw new OrreryError("not_found", "unknown provider");
  });

  /* ---------------------------------------------------------------- bots */
  const validateProviders = (b: Pick<Bot, "primary" | "routing">) => {
    if (b.routing.mode === "auto" && b.routing.fast && !deps.providers.has(b.routing.fast.providerId)) throw new OrreryError("bad_request", `unknown provider ${b.routing.fast.providerId}`);
    if (b.primary.kind === "openai" && !deps.providers.has(b.primary.providerId)) throw new OrreryError("bad_request", `unknown provider ${b.primary.providerId}`);
    if (b.primary.kind === "opencode-acp") {
      for (const m of [b.primary.modelId, b.primary.smallModelId]) {
        const problem = m ? openCodeModelProblem(m, deps.providers.configs) : null;
        if (problem) throw new OrreryError("bad_request", problem);
      }
    }
  };
  route("get", "/v1/bots", { summary: "List bots", tag: "bots" }, async (_c, { p }) => ({ bots: await bots.list(db, p.teamId) }));
  route("post", "/v1/bots", { summary: "Create a bot", tag: "bots", role: "admin", body: BotCreateSchema, status: 201 }, async (_c, { p, body }) => {
    const input = BotCreateSchema.parse(body);
    if (!input.policy.rules.length) input.policy.rules = defaultPolicyRules();
    validateProviders(input);
    const bot = await bots.create(db, p.teamId, input);
    await workflows.ensureBotSchedules(bot).catch((err: unknown) => deps.log.warn({ err: String(err) }, "could not create bot schedules"));
    if (bot.instructions) await memory.setCoreMemory(bot.id, "persona", bot.instructions.slice(0, bot.memory.coreMemoryCharLimit), bot.memory.coreMemoryCharLimit);
    await log(p, "bot.create", bot.id, { name: bot.name, primary: bot.primary.kind });
    return { bot };
  });
  route("get", "/v1/bots/:id", { summary: "Get a bot", tag: "bots" }, async (c, { p }) => {
    const bot = await mustBot(p, c.req.param("id")!);
    return { bot, state: await workflows.botState(bot.id) };
  });
  route("patch", "/v1/bots/:id", { summary: "Update a bot", tag: "bots", role: "admin", body: BotPatchSchema }, async (c, { p, body }) => {
    const prev = await mustBot(p, c.req.param("id")!);
    const patch = BotPatchSchema.parse(body);
    validateProviders({ primary: patch.primary ?? prev.primary, routing: patch.routing ?? prev.routing });
    const bot = await bots.update(db, p.teamId, prev.id, patch as never);
    if (prev.status !== bot.status && (bot.status === "paused" || prev.status === "paused")) await workflows.setPaused(bot.id, bot.teamId, bot.status === "paused");
    await log(p, "bot.update", bot.id, { fields: Object.keys(body as object) });
    return { bot };
  });
  route("delete", "/v1/bots/:id", { summary: "Archive a bot", tag: "bots", role: "admin" }, async (c, { p }) => {
    const bot = await mustBot(p, c.req.param("id")!);
    await bots.update(db, p.teamId, bot.id, { status: "archived" });
    await workflows.setPaused(bot.id, bot.teamId, true);
    await log(p, "bot.archive", bot.id);
  });
  route("get", "/v1/bots/:id/core-memory", { summary: "Core memory blocks", tag: "memory" }, async (c, { p }) => memory.coreMemory((await mustBot(p, c.req.param("id")!)).id));
  route("put", "/v1/bots/:id/core-memory/:block", { summary: "Replace a core memory block", tag: "memory", role: "member", body: z.object({ content: z.string().max(20000) }) }, async (c, { p, body }) => {
    const bot = await mustBot(p, c.req.param("id")!);
    const block = z.enum(["persona", "human", "notes"]).parse(c.req.param("block"));
    return { content: await memory.setCoreMemory(bot.id, block, body.content, bot.memory.coreMemoryCharLimit) };
  });
  route("post", "/v1/bots/:id/consolidate", { summary: "Run memory consolidation now", tag: "memory", role: "member" }, async (c, { p }) => {
    const bot = await mustBot(p, c.req.param("id")!);
    await workflows.consolidateNow(bot.teamId, bot.id);
    return { started: true };
  });
  route("get", "/v1/bots/:id/webhook-token", { summary: "Mint an inbound webhook token for a bot", tag: "bots", role: "admin" }, async (c, { p }) => {
    const bot = await mustBot(p, c.req.param("id")!);
    await log(p, "bot.webhook_token", bot.id);
    return { token: signToken({ sub: bot.id, aud: WEBHOOK_AUDIENCE, exp: Math.floor(Date.now() / 1000) + 365 * 86400, team: bot.teamId }, env.MCP_TOKEN_SECRET), url: `${env.PUBLIC_BASE_URL}/v1/hooks/bots/${bot.id}` };
  });

  /* ---------------------------------------------------------------- threads & messages */
  route("get", "/v1/bots/:id/threads", { summary: "List threads of a bot", tag: "threads", query: z.object({ before: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }) }, async (c, { p, query }) => {
    const bot = await mustBot(p, c.req.param("id")!);
    return { threads: await threads.list(db, p.teamId, bot.id, query.limit, query.before) };
  });
  route("post", "/v1/bots/:id/threads", { summary: "Start a thread", tag: "threads", role: "member", body: z.object({ title: z.string().max(200).optional() }), status: 201 }, async (c, { p, body }) => {
    const bot = await mustBot(p, c.req.param("id")!);
    return { thread: await threads.create(db, { teamId: p.teamId, botId: bot.id, channel: "web", createdBy: p.userId, ...(body.title ? { title: body.title } : {}) }) };
  });
  route("get", "/v1/threads/:id", { summary: "Get a thread", tag: "threads" }, async (c, { p }) => ({ thread: await mustThread(p, c.req.param("id")!) }));
  route("delete", "/v1/threads/:id", { summary: "Archive a thread", tag: "threads", role: "member" }, async (c, { p }) => {
    await threads.archive(db, p.teamId, (await mustThread(p, c.req.param("id")!)).id);
  });
  route("get", "/v1/threads/:id/messages", { summary: "Messages of a thread", tag: "threads", query: z.object({ before: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }) }, async (c, { p, query }) => {
    const t = await mustThread(p, c.req.param("id")!);
    return { messages: await messages.list(db, t.id, query.limit, query.before) };
  });
  route("post", "/v1/threads/:id/messages", { summary: "Send a message (queue a turn or steer the running one)", tag: "threads", role: "member", body: SendMessageSchema, status: 202 }, async (c, { p, body }) => {
    const t = await mustThread(p, c.req.param("id")!);
    const bot = await mustBot(p, t.botId);
    if (bot.status === "archived") throw new OrreryError("conflict", "bot is archived");
    const parts: ContentPart[] = body.parts ?? [{ type: "text", text: body.text! }];
    const author = { type: "user" as const, id: p.userId, ...(p.name ? { name: p.name } : {}) };
    // Agents that cannot take guidance mid-turn get it as the next turn instead.
    if (body.mode === "steer" && canSteer(bot)) {
      const active = (await runs.listForThread(db, t.id, 5)).find((r) => r.status === "running" || r.status === "waiting_approval");
      if (active && canSteer(bot, active)) {
        const msg = await withTx(db, async (tx) => {
          const m = await messages.insert(tx, { teamId: p.teamId, threadId: t.id, role: "user", author, parts, runId: active.id, meta: { steered: true } });
          await steering.add(tx, active.id, parts, p.userId, m.id);
          return m;
        });
        return { messageId: msg.id, threadId: t.id, mode: "steer", runId: active.id };
      }
    }
    const { message: msg, delivered } = await deps.delivery.submit(
      { teamId: p.teamId, threadId: t.id, role: "user", author, parts },
      { threadId: t.id, botId: bot.id, teamId: p.teamId, channel: t.channel, author, parts, replyTo: null, ...(body.forceProvider ? { forceProvider: body.forceProvider } : {}) },
    );
    return { messageId: msg.id, threadId: t.id, mode: "queue", delivery: delivered ? "delivered" : "pending" };
  });

  /* ---------------------------------------------------------------- runs */
  route("get", "/v1/threads/:id/runs", { summary: "Runs of a thread", tag: "runs" }, async (c, { p }) => ({ runs: await runs.listForThread(db, (await mustThread(p, c.req.param("id")!)).id) }));
  route("get", "/v1/runs/active", { summary: "Active runs (fleet view)", tag: "runs" }, async (_c, { p }) => ({ runs: await runs.active(db, p.teamId) }));
  route("get", "/v1/runs/:id", { summary: "Get a run", tag: "runs" }, async (c, { p }) => {
    const run = await mustRun(p, c.req.param("id")!);
    return { run, progress: run.status === "running" || run.status === "waiting_approval" ? await workflows.runProgress(run.id) : null, traceUrl: langfuseTraceUrl(env.LANGFUSE_UI_URL ?? env.LANGFUSE_BASE_URL, run.traceId) };
  });
  route("get", "/v1/runs/:id/events", { summary: "Events of a run", tag: "runs", query: z.object({ after: z.coerce.number().int().min(0).default(0) }) }, async (c, { p, query }) => {
    const run = await mustRun(p, c.req.param("id")!);
    return { events: await events.listForRun(db, run.id, query.after) };
  });
  route("post", "/v1/runs/:id/cancel", { summary: "Cancel a running turn", tag: "runs", role: "member" }, async (c, { p }) => {
    const run = await mustRun(p, c.req.param("id")!);
    const ok = await workflows.cancelRun(run.id);
    await log(p, "run.cancel", run.id);
    return { cancelled: ok };
  });
  route("post", "/v1/runs/:id/steer", { summary: "Inject guidance into a running turn (or queue it as the next turn when the agent cannot be steered)", tag: "runs", role: "member", body: z.object({ text: z.string().min(1).max(20000) }) }, async (c, { p, body }) => {
    const run = await mustRun(p, c.req.param("id")!);
    if (run.status !== "running" && run.status !== "waiting_approval") throw new OrreryError("conflict", "run is not active");
    const parts: ContentPart[] = [{ type: "text", text: body.text }];
    const author = { type: "user" as const, id: p.userId, ...(p.name ? { name: p.name } : {}) };
    const bot = await mustBot(p, run.botId);
    if (!canSteer(bot, run)) {
      const t = await mustThread(p, run.threadId);
      const { message, delivered } = await deps.delivery.submit({ teamId: p.teamId, threadId: t.id, role: "user", author, parts }, { threadId: t.id, botId: bot.id, teamId: p.teamId, channel: t.channel, author, parts, replyTo: null });
      return { queued: true, mode: "queue", messageId: message.id, delivery: delivered ? "delivered" : "pending" };
    }
    const message = await withTx(db, async (tx) => {
      const m = await messages.insert(tx, { teamId: p.teamId, threadId: run.threadId, role: "user", author, parts, runId: run.id, meta: { steered: true } });
      await steering.add(tx, run.id, parts, p.userId, m.id);
      return m;
    });
    return { queued: true, mode: "steer", messageId: message.id };
  });
  route("post", "/v1/runs/:id/feedback", { summary: "Rate a run (sent to Langfuse as a score)", tag: "runs", role: "member", body: z.object({ value: z.number().min(-1).max(1), comment: z.string().max(4000).optional() }) }, async (c, { p, body }) => {
    const run = await mustRun(p, c.req.param("id")!);
    if (run.traceId) scoreTrace(deps.telemetry?.langfuse ?? null, { traceId: run.traceId, name: "user_feedback", value: body.value, ...(body.comment ? { comment: body.comment } : {}), sessionId: run.threadId });
    await log(p, "run.feedback", run.id, { value: body.value });
  });

  /* ---------------------------------------------------------------- approvals */
  route("get", "/v1/approvals", { summary: "Pending approvals", tag: "approvals", query: z.object({ botId: z.string().optional() }) }, async (_c, { p, query }) => ({ approvals: await approvals.listPending(db, p.teamId, query.botId) }));
  route("get", "/v1/approvals/:id", { summary: "Get an approval", tag: "approvals" }, async (c, { p }) => {
    const a = await approvals.get(db, p.teamId, c.req.param("id")!);
    if (!a) throw new OrreryError("not_found", "approval not found");
    return { approval: a };
  });
  route("post", "/v1/approvals/:id/decide", { summary: "Decide an approval (allow/deny, optionally persistent)", tag: "approvals", role: "member", body: ApprovalDecisionSchema }, async (c, { p, body }) => {
    const a = await approvals.get(db, p.teamId, c.req.param("id")!);
    if (!a) throw new OrreryError("not_found", "approval not found");
    if (a.status !== "pending") throw new OrreryError("conflict", `approval already ${a.status}`);
    let option = body.optionId ? a.options.find((o) => o.optionId === body.optionId) : body.optionKind ? a.options.find((o) => o.kind === body.optionKind) : undefined;
    if (!body.cancel && !option) throw new OrreryError("bad_request", "choose one of the offered options");
    const persistent = option?.kind === "allow_always" || option?.kind === "reject_always";
    if (persistent && body.persist && !a.consent) throw new OrreryError("bad_request", "this request cannot be persisted");
    if (persistent && option?.kind === "allow_always") requireRole(p, "admin"); // standing grants are an admin power
    const status = body.cancel ? "cancelled" : option!.kind.startsWith("allow") ? "approved" : "denied";
    const decided = await approvals.decide(db, a.id, status, {
      optionId: body.cancel ? null : option!.optionId,
      optionKind: body.cancel ? null : option!.kind,
      persist: persistent && body.persist ? body.persist : null,
      by: p.userId,
      at: nowIso(),
      note: body.note ?? null,
    });
    if (!decided) throw new OrreryError("conflict", "approval was decided concurrently");
    await workflows.signalApproval(a.runId, { approvalId: a.id, optionId: decided.decision?.optionId ?? null, optionKind: (decided.decision?.optionKind as never) ?? null, cancelled: Boolean(body.cancel), actor: p.userId });
    await log(p, "approval.decide", a.id, { status, option: option?.kind ?? null, persist: decided.decision?.persist ?? null, resource: a.resource });
    return { approval: decided };
  });

  /* ---------------------------------------------------------------- memory */
  route("get", "/v1/memories", { summary: "List memories", tag: "memory", query: z.object({ botId: z.string().optional(), kind: MemoryKindSchema.optional(), q: z.string().optional(), includeSuperseded: z.coerce.boolean().default(false), limit: z.coerce.number().int().min(1).max(500).default(200) }) }, async (_c, { p, query }) => ({
    memories: await memory.list(p.teamId, { ...(query.botId ? { botId: query.botId } : {}), ...(query.kind ? { kind: query.kind } : {}), ...(query.q ? { search: query.q } : {}), includeSuperseded: query.includeSuperseded, limit: query.limit }),
  }));
  route("post", "/v1/memories", { summary: "Teach a bot something", tag: "memory", role: "member", body: MemoryWriteSchema.extend({ botId: z.string() }), status: 201 }, async (_c, { p, body }) => {
    const bot = await mustBot(p, body.botId);
    const out = await memory.gateAndWrite({ teamId: p.teamId, botId: bot.id, userId: p.userId }, [{ kind: body.kind, content: body.content, importance: body.importance, tags: body.tags, scope: body.scope, pinned: body.pinned }], "user");
    await log(p, "memory.write", out[0]?.id ?? null, { action: out[0]?.action });
    return { result: out[0] };
  });
  route("post", "/v1/memories/search", { summary: "Recall like the bot would", tag: "memory", body: z.object({ botId: z.string(), query: z.string().min(1), k: z.number().int().min(1).max(50).default(10) }) }, async (_c, { p, body }) => {
    const bot = await mustBot(p, body.botId);
    return { results: await memory.recall({ teamId: p.teamId, botId: bot.id, userId: p.userId, query: body.query, k: body.k, shareScope: bot.memory.shareScope }) };
  });
  route("patch", "/v1/memories/:id", { summary: "Edit, pin or re-rank a memory", tag: "memory", role: "member", body: z.object({ content: z.string().min(1).max(4000).optional(), importance: z.number().min(0).max(1).optional(), pinned: z.boolean().optional(), tags: z.array(z.string()).optional(), kind: MemoryKindSchema.optional() }) }, async (c, { p, body }) => {
    const m = await memory.update(p.teamId, c.req.param("id")!, body);
    if (!m) throw new OrreryError("not_found", "memory not found");
    await log(p, "memory.update", m.id, { fields: Object.keys(body) });
    return { memory: m };
  });
  route("delete", "/v1/memories/:id", { summary: "Forget a memory (soft) or purge it (?purge=true, admin)", tag: "memory", role: "member", query: z.object({ purge: z.coerce.boolean().default(false) }) }, async (c, { p, query }) => {
    const id = c.req.param("id")!;
    if (query.purge) {
      requireRole(p, "admin");
      await memory.purge(p.teamId, id);
    } else if (!(await memory.forget(p.teamId, id))) throw new OrreryError("not_found", "memory not found");
    await log(p, query.purge ? "memory.purge" : "memory.forget", id);
  });

  /* ---------------------------------------------------------------- knowledge */
  route("get", "/v1/knowledge-bases", { summary: "List knowledge bases", tag: "knowledge" }, async (_c, { p }) => ({ knowledgeBases: await knowledge.listBases(db, p.teamId) }));
  route("post", "/v1/knowledge-bases", { summary: "Create a knowledge base", tag: "knowledge", role: "admin", body: z.object({ name: z.string().min(1).max(120), description: z.string().max(2000).default(""), chunkSize: z.number().int().min(200).max(8000).default(1200), chunkOverlap: z.number().int().min(0).max(2000).default(150) }), status: 201 }, async (_c, { p, body }) => {
    const embed = deps.providers.modelFor("embed");
    const kb = await knowledge.createBase(db, { teamId: p.teamId, name: body.name, description: body.description, embeddingModel: embed?.model ?? "", embeddingDims: embed?.client.config.models.embedDims ?? 0, chunkSize: body.chunkSize, chunkOverlap: body.chunkOverlap });
    await log(p, "knowledge.create", kb.id);
    return { knowledgeBase: kb };
  });
  route("get", "/v1/knowledge-bases/:id/sources", { summary: "Sources of a knowledge base", tag: "knowledge" }, async (c, { p }) => {
    const kb = await knowledge.getBase(db, c.req.param("id")!);
    if (!kb || kb.teamId !== p.teamId) throw new OrreryError("not_found", "knowledge base not found");
    return { sources: await knowledge.listSources(db, kb.id) };
  });
  openapi.add({ method: "post", path: "/v1/knowledge-bases/:id/sources", summary: "Add a source (JSON url/text, or multipart file upload)", tag: "knowledge", role: "member" });
  app.post("/v1/knowledge-bases/:id/sources", async (c) => {
    const p = await deps.auth.authenticate(c.req.header("authorization"));
    requireRole(p, "member");
    const kb = await knowledge.getBase(db, c.req.param("id"));
    if (!kb || kb.teamId !== p.teamId) throw new OrreryError("not_found", "knowledge base not found");
    let src;
    if ((c.req.header("content-type") ?? "").includes("multipart/form-data")) {
      const form = await c.req.parseBody();
      const file = form.file;
      if (!(file instanceof File)) throw new OrreryError("bad_request", "multipart field 'file' is required");
      if (file.size > 25 * 1024 * 1024) throw new OrreryError("bad_request", "file too large (25 MB max)");
      src = await knowledge.addSource(db, { knowledgeBaseId: kb.id, type: "upload", uri: file.name, title: String(form.title ?? file.name), mimeType: file.type || null, content: Buffer.from(await file.arrayBuffer()) });
    } else {
      const b = z
        .discriminatedUnion("type", [
          z.object({ type: z.literal("url"), uri: z.string().url(), title: z.string().max(300).optional() }),
          z.object({ type: z.literal("text"), title: z.string().min(1).max(300), text: z.string().min(1).max(5_000_000), mimeType: z.string().default("text/markdown") }),
        ])
        .parse(await c.req.json());
      src = b.type === "url"
        ? await knowledge.addSource(db, { knowledgeBaseId: kb.id, type: "url", uri: b.uri, title: b.title ?? b.uri })
        : await knowledge.addSource(db, { knowledgeBaseId: kb.id, type: "text", uri: `text:${b.title}`, title: b.title, mimeType: b.mimeType, content: Buffer.from(b.text) });
    }
    await workflows.startIngest(src.id);
    await log(p, "knowledge.source.add", src.id, { kb: kb.id, type: src.type });
    return c.json({ source: src }, 201);
  });
  route("post", "/v1/sources/:id/reingest", { summary: "Re-ingest a source", tag: "knowledge", role: "member" }, async (c, { p }) => {
    const s = await knowledge.getSource(db, c.req.param("id")!);
    const kb = s ? await knowledge.getBase(db, s.knowledgeBaseId) : null;
    if (!s || !kb || kb.teamId !== p.teamId) throw new OrreryError("not_found", "source not found");
    await workflows.startIngest(s.id);
    return { started: true };
  });
  route("delete", "/v1/sources/:id", { summary: "Delete a source and its chunks", tag: "knowledge", role: "member" }, async (c, { p }) => {
    const s = await knowledge.getSource(db, c.req.param("id")!);
    const kb = s ? await knowledge.getBase(db, s.knowledgeBaseId) : null;
    if (!s || !kb || kb.teamId !== p.teamId) throw new OrreryError("not_found", "source not found");
    await knowledge.deleteSource(db, s.id);
    await log(p, "knowledge.source.delete", s.id);
  });
  route("post", "/v1/knowledge/search", { summary: "Search knowledge bases (with Clef evidence filter)", tag: "knowledge", body: z.object({ knowledgeBaseIds: z.array(z.string()).min(1), query: z.string().min(1), k: z.number().int().min(1).max(30).default(8) }) }, async (_c, { p, body }) =>
    deps.knowledge.search({ teamId: p.teamId, knowledgeBaseIds: body.knowledgeBaseIds, query: body.query, k: body.k }),
  );

  /* ---------------------------------------------------------------- routines */
  route("get", "/v1/routines", { summary: "List routines", tag: "routines", query: z.object({ botId: z.string().optional() }) }, async (_c, { p, query }) => ({ routines: await routines.list(db, p.teamId, query.botId) }));
  route("post", "/v1/routines", { summary: "Create a routine (Temporal schedule)", tag: "routines", role: "member", body: RoutineCreateSchema, status: 201 }, async (_c, { p, body }) => {
    await mustBot(p, body.botId);
    const r = await routines.create(db, p.teamId, RoutineCreateSchema.parse(body) as never);
    await workflows.upsertRoutine(r);
    await log(p, "routine.create", r.id);
    return { routine: r };
  });
  route("patch", "/v1/routines/:id", { summary: "Update a routine", tag: "routines", role: "member", body: z.object({ name: z.string().optional(), prompt: z.string().optional(), schedule: RoutineScheduleSchema.optional(), enabled: z.boolean().optional(), threadPolicy: z.enum(["new", "reuse"]).optional() }) }, async (c, { p, body }) => {
    const r = await routines.update(db, p.teamId, c.req.param("id")!, body as never);
    if (!r) throw new OrreryError("not_found", "routine not found");
    await workflows.upsertRoutine(r);
    return { routine: r };
  });
  route("delete", "/v1/routines/:id", { summary: "Delete a routine", tag: "routines", role: "member" }, async (c, { p }) => {
    const id = c.req.param("id")!;
    if (!(await routines.delete(db, p.teamId, id))) throw new OrreryError("not_found", "routine not found");
    await workflows.deleteRoutine(id);
  });
  route("post", "/v1/routines/:id/run", { summary: "Run a routine now", tag: "routines", role: "member" }, async (c, { p }) => {
    const r = (await routines.list(db, p.teamId)).find((x) => x.id === c.req.param("id"));
    if (!r) throw new OrreryError("not_found", "routine not found");
    await workflows.triggerRoutine(r.id);
    return { triggered: true };
  });

  /* ---------------------------------------------------------------- governance */
  route("get", "/v1/usage", { summary: "Usage per bot and provider", tag: "governance", query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }) }, async (_c, { p, query }) => ({ since: new Date(Date.now() - query.days * 86400_000).toISOString(), rows: await usage.summary(db, p.teamId, new Date(Date.now() - query.days * 86400_000).toISOString()) }));
  route("get", "/v1/audit", { summary: "Audit log", tag: "governance", role: "admin" }, async (_c, { p }) => ({ entries: await audit.list(db, p.teamId) }));
  route("get", "/v1/computers", { summary: "Bot computers", tag: "governance" }, async (_c, { p }) => ({ computers: await computers.list(db, p.teamId) }));
  route("get", "/v1/secrets", { summary: "Secret names (values are never returned)", tag: "governance", role: "admin" }, async (_c, { p }) => ({ secrets: await secrets.list(db, p.teamId) }));
  route("put", "/v1/secrets/:name", { summary: "Store a secret (reference it as secret://name)", tag: "governance", role: "admin", body: z.object({ value: z.string().min(1).max(100_000) }) }, async (c, { p, body }) => {
    await secrets.put(db, p.teamId, c.req.param("name")!, body.value, env.ENCRYPTION_KEY);
    await log(p, "secret.put", c.req.param("name")!);
  });
  route("delete", "/v1/secrets/:name", { summary: "Delete a secret", tag: "governance", role: "admin" }, async (c, { p }) => {
    await secrets.delete(db, p.teamId, c.req.param("name")!);
    await log(p, "secret.delete", c.req.param("name")!);
  });

  /* ---------------------------------------------------------------- inbound webhooks */
  openapi.add({ method: "post", path: "/v1/hooks/bots/:id", summary: "Trigger a bot from an external system (webhook token)", tag: "bots" });
  app.post("/v1/hooks/bots/:id", async (c) => {
    const token = /^Bearer\s+(.+)$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? c.req.query("token");
    const claims = token ? verifyToken<{ sub: string; aud: string; exp: number; team: string }>(token, env.MCP_TOKEN_SECRET, WEBHOOK_AUDIENCE) : null;
    if (!claims || claims.sub !== c.req.param("id")) throw new OrreryError("unauthorized", "invalid webhook token");
    const bot = await bots.getById(db, claims.sub);
    if (!bot || bot.teamId !== claims.team || bot.status !== "active") throw new OrreryError("not_found", "bot not available");
    const body = z.object({ text: z.string().min(1).max(100_000), threadId: z.string().optional(), source: z.string().max(100).default("webhook") }).parse(await c.req.json());
    let threadId = body.threadId;
    if (threadId && !(await threads.get(db, bot.teamId, threadId))) threadId = undefined;
    if (!threadId) threadId = (await threads.create(db, { teamId: bot.teamId, botId: bot.id, channel: "webhook", createdBy: `webhook:${body.source}`, title: `Webhook: ${body.source}` })).id;
    const author = { type: "system" as const, id: `webhook:${body.source}`, name: body.source };
    const parts: ContentPart[] = [{ type: "text", text: body.text }];
    const { message: msg, delivered } = await deps.delivery.submit({ teamId: bot.teamId, threadId, role: "user", author, parts }, { threadId, botId: bot.id, teamId: bot.teamId, channel: "webhook", author, parts, replyTo: null });
    return c.json({ threadId, messageId: msg.id, delivery: delivered ? "delivered" : "pending" }, 202);
  });

  /* ---------------------------------------------------------------- streams (SSE) */
  openapi.add({ method: "get", path: "/v1/threads/:id/events", summary: "Live event stream of a thread (SSE, resumable via Last-Event-ID)", tag: "threads", stream: true });
  app.get("/v1/threads/:id/events", async (c) => {
    const p = await deps.auth.authenticate(c.req.header("authorization") ?? (c.req.query("access_token") ? `Bearer ${c.req.query("access_token")}` : null));
    const t = await mustThread(p, c.req.param("id"));
    const hub = deps.hub;
    if (!hub) throw new OrreryError("provider_unavailable", "streaming disabled");
    const cursor = c.req.header("last-event-id") ?? c.req.query("since") ?? null;
    return streamSSE(c, async (stream) => {
      const seen = new Set<string>();
      const send = (e: RunEventEnvelope) => {
        const key = `${e.runId}:${e.seq}`;
        if (seen.has(key)) return;
        seen.add(key);
        if (seen.size > 20_000) seen.clear();
        void stream.writeSSE({ id: `${e.ts}|${key}`, event: "run_event", data: JSON.stringify(e) });
      };
      const unsub = hub.subscribeThread(t.id, { send, teamId: p.teamId });
      try {
        for (const e of await hub.backlog(t.id, cursor)) send(e);
        await stream.writeSSE({ event: "ready", data: "{}" });
        while (!stream.aborted) {
          await stream.sleep(15_000);
          await stream.writeSSE({ event: "ping", data: String(Date.now()) });
        }
      } finally {
        unsub();
      }
    });
  });
  openapi.add({ method: "get", path: "/v1/stream", summary: "Team-wide notifications (runs, approvals) for fleet views (SSE)", tag: "platform", stream: true });
  app.get("/v1/stream", async (c) => {
    const p = await deps.auth.authenticate(c.req.header("authorization") ?? (c.req.query("access_token") ? `Bearer ${c.req.query("access_token")}` : null));
    const hub = deps.hub;
    if (!hub) throw new OrreryError("provider_unavailable", "streaming disabled");
    return streamSSE(c, async (stream) => {
      const unsub = hub.subscribeTeam(p.teamId, { send: (n) => void stream.writeSSE({ event: n.kind, data: JSON.stringify(n) }) });
      try {
        await stream.writeSSE({ event: "ready", data: "{}" });
        while (!stream.aborted) {
          await stream.sleep(15_000);
          await stream.writeSSE({ event: "ping", data: String(Date.now()) });
        }
      } finally {
        unsub();
      }
    });
  });

  /* ---------------------------------------------------------------- docs */
  app.get("/openapi.json", (c) => c.json(openapi.document({ title: "Orrery API", version: "0.1.0", serverUrl: env.PUBLIC_BASE_URL })));
  app.get("/docs", (c) =>
    c.html(`<!doctype html><html><head><title>Orrery API</title><meta charset="utf-8"/></head><body><redoc spec-url="/openapi.json"></redoc><script src="https://cdn.jsdelivr.net/npm/redoc@2/bundles/redoc.standalone.js"></script></body></html>`),
  );

  return { app, openapi };
}
