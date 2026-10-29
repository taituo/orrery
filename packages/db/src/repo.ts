import {
  BotSchema,
  OrreryError,
  newId,
  type AgentEvent,
  type Approval,
  type ApprovalStatus,
  type Bot,
  type Channel,
  type ContentPart,
  type KnowledgeBase,
  type KnowledgeSource,
  type Message,
  type MessageRole,
  type Routine,
  type Run,
  type RunEventEnvelope,
  type RunStatus,
  type Thread,
  type UsageSnapshot,
} from "@orrery/core";
import type { Queryable } from "./pool.js";

/**
 * Data access. Every query is scoped by `team_id` where the entity is tenant-owned; callers
 * pass the authenticated team. Rows are mapped to the domain types from @orrery/core.
 */

const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
const isoReq = (d: Date | string): string => new Date(d).toISOString();

/* ------------------------------------------------------------------ teams & users */

export const teams = {
  async ensure(db: Queryable, id: string, name: string): Promise<void> {
    await db.query("INSERT INTO teams (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [id, name]);
  },
  async get(db: Queryable, id: string): Promise<{ id: string; name: string; settings: Record<string, unknown> } | null> {
    const r = await db.query("SELECT id, name, settings FROM teams WHERE id = $1", [id]);
    return (r.rows[0] as { id: string; name: string; settings: Record<string, unknown> } | undefined) ?? null;
  },
};

export interface UserRow {
  id: string;
  teamId: string;
  externalId: string | null;
  email: string | null;
  name: string | null;
  role: "owner" | "admin" | "member" | "viewer";
}

export const users = {
  /** Upsert from an OIDC identity. */
  async upsertExternal(db: Queryable, u: { teamId: string; externalId: string; email?: string | null; name?: string | null; role: UserRow["role"] }): Promise<UserRow> {
    const r = await db.query(
      `INSERT INTO users (id, team_id, external_id, email, name, role) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (team_id, external_id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name, role = EXCLUDED.role
       RETURNING id, team_id, external_id, email, name, role`,
      [newId("user"), u.teamId, u.externalId, u.email ?? null, u.name ?? null, u.role],
    );
    const row = r.rows[0] as Record<string, string>;
    return { id: row.id!, teamId: row.team_id!, externalId: row.external_id ?? null, email: row.email ?? null, name: row.name ?? null, role: row.role as UserRow["role"] };
  },
};

/* ------------------------------------------------------------------ bots */

function botFromRow(r: Record<string, unknown>): Bot {
  return BotSchema.parse({
    ...(r.spec as Record<string, unknown>),
    id: r.id,
    teamId: r.team_id,
    name: r.name,
    status: r.status,
    createdAt: isoReq(r.created_at as Date),
    updatedAt: isoReq(r.updated_at as Date),
  });
}

function botSpec(b: Omit<Bot, "id" | "teamId" | "name" | "status" | "createdAt" | "updatedAt">): Record<string, unknown> {
  return { ...b };
}

export const bots = {
  async create(db: Queryable, teamId: string, input: Omit<Bot, "id" | "teamId" | "createdAt" | "updatedAt" | "status"> & { status?: Bot["status"] }): Promise<Bot> {
    const id = newId("bot");
    const { name, status, ...spec } = input;
    const r = await db.query("INSERT INTO bots (id, team_id, name, status, spec) VALUES ($1, $2, $3, $4, $5) RETURNING *", [id, teamId, name, status ?? "active", JSON.stringify(botSpec(spec))]);
    return botFromRow(r.rows[0]);
  },
  async get(db: Queryable, teamId: string, id: string): Promise<Bot | null> {
    const r = await db.query("SELECT * FROM bots WHERE id = $1 AND team_id = $2", [id, teamId]);
    return r.rows[0] ? botFromRow(r.rows[0]) : null;
  },
  /** Internal (workers): no tenant scope, bot ids come from durable workflow state. */
  async getById(db: Queryable, id: string): Promise<Bot | null> {
    const r = await db.query("SELECT * FROM bots WHERE id = $1", [id]);
    return r.rows[0] ? botFromRow(r.rows[0]) : null;
  },
  async list(db: Queryable, teamId: string, opts: { includeArchived?: boolean } = {}): Promise<Bot[]> {
    const r = await db.query(`SELECT * FROM bots WHERE team_id = $1 ${opts.includeArchived ? "" : "AND status <> 'archived'"} ORDER BY created_at`, [teamId]);
    return r.rows.map(botFromRow);
  },
  async update(db: Queryable, teamId: string, id: string, patch: Partial<Omit<Bot, "id" | "teamId" | "createdAt" | "updatedAt">>): Promise<Bot> {
    const current = await bots.get(db, teamId, id);
    if (!current) throw new OrreryError("not_found", `bot ${id} not found`);
    const merged = BotSchema.parse({ ...current, ...patch, updatedAt: new Date().toISOString() });
    const { id: _i, teamId: _t, name, status, createdAt: _c, updatedAt: _u, ...spec } = merged;
    const r = await db.query("UPDATE bots SET name = $3, status = $4, spec = $5, updated_at = now() WHERE id = $1 AND team_id = $2 RETURNING *", [id, teamId, name, status, JSON.stringify(spec)]);
    return botFromRow(r.rows[0]);
  },
};

/* ------------------------------------------------------------------ threads & messages */

function threadFromRow(r: Record<string, unknown>): Thread {
  return {
    id: r.id as string,
    teamId: r.team_id as string,
    botId: r.bot_id as string,
    title: r.title as string,
    channel: r.channel as Channel,
    acpSessionId: (r.acp_session_id as string | null) ?? null,
    createdBy: r.created_by as string,
    archived: r.archived as boolean,
    lastActivityAt: isoReq(r.last_activity_at as Date),
    createdAt: isoReq(r.created_at as Date),
  };
}

export const threads = {
  async create(db: Queryable, t: { teamId: string; botId: string; channel: Channel; createdBy: string; title?: string; id?: string }): Promise<Thread> {
    const r = await db.query("INSERT INTO threads (id, team_id, bot_id, channel, created_by, title) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *", [
      t.id ?? newId("thread"),
      t.teamId,
      t.botId,
      t.channel,
      t.createdBy,
      t.title ?? "New conversation",
    ]);
    return threadFromRow(r.rows[0]);
  },
  async get(db: Queryable, teamId: string, id: string): Promise<Thread | null> {
    const r = await db.query("SELECT * FROM threads WHERE id = $1 AND team_id = $2", [id, teamId]);
    return r.rows[0] ? threadFromRow(r.rows[0]) : null;
  },
  async getById(db: Queryable, id: string): Promise<(Thread & { acpAgentEpoch: string | null }) | null> {
    const r = await db.query("SELECT * FROM threads WHERE id = $1", [id]);
    return r.rows[0] ? { ...threadFromRow(r.rows[0]), acpAgentEpoch: (r.rows[0].acp_agent_epoch as string | null) ?? null } : null;
  },
  async list(db: Queryable, teamId: string, botId: string, limit = 50, before?: string): Promise<Thread[]> {
    const r = await db.query(
      `SELECT * FROM threads WHERE team_id = $1 AND bot_id = $2 AND NOT archived ${before ? "AND last_activity_at < $4" : ""} ORDER BY last_activity_at DESC LIMIT $3`,
      before ? [teamId, botId, limit, before] : [teamId, botId, limit],
    );
    return r.rows.map(threadFromRow);
  },
  async setAcpSession(db: Queryable, threadId: string, sessionId: string | null, epoch: string | null): Promise<void> {
    await db.query("UPDATE threads SET acp_session_id = $2, acp_agent_epoch = $3 WHERE id = $1", [threadId, sessionId, epoch]);
  },
  async touch(db: Queryable, threadId: string): Promise<void> {
    await db.query("UPDATE threads SET last_activity_at = now() WHERE id = $1", [threadId]);
  },
  async setTitle(db: Queryable, threadId: string, title: string): Promise<void> {
    await db.query("UPDATE threads SET title = $2 WHERE id = $1", [threadId, title.slice(0, 200)]);
  },
  async archive(db: Queryable, teamId: string, threadId: string): Promise<void> {
    await db.query("UPDATE threads SET archived = true WHERE id = $1 AND team_id = $2", [threadId, teamId]);
  },
};

function messageFromRow(r: Record<string, unknown>): Message {
  return {
    id: r.id as string,
    threadId: r.thread_id as string,
    role: r.role as MessageRole,
    author: r.author as Message["author"],
    parts: r.parts as ContentPart[],
    runId: (r.run_id as string | null) ?? null,
    createdAt: isoReq(r.created_at as Date),
    meta: (r.meta as Record<string, unknown>) ?? {},
  };
}

export const messages = {
  async insert(db: Queryable, m: Omit<Message, "createdAt" | "id"> & { id?: string; teamId: string }): Promise<Message> {
    const r = await db.query(
      `INSERT INTO messages (id, team_id, thread_id, role, author, parts, run_id, meta) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET parts = EXCLUDED.parts, meta = EXCLUDED.meta RETURNING *`,
      [m.id ?? newId("message"), m.teamId, m.threadId, m.role, JSON.stringify(m.author), JSON.stringify(m.parts), m.runId ?? null, JSON.stringify(m.meta ?? {})],
    );
    return messageFromRow(r.rows[0]);
  },
  async list(db: Queryable, threadId: string, limit = 200, beforeIso?: string): Promise<Message[]> {
    const r = await db.query(
      `SELECT * FROM (SELECT * FROM messages WHERE thread_id = $1 ${beforeIso ? "AND created_at < $3" : ""} ORDER BY created_at DESC LIMIT $2) x ORDER BY created_at ASC`,
      beforeIso ? [threadId, limit, beforeIso] : [threadId, limit],
    );
    return r.rows.map(messageFromRow);
  },
  async get(db: Queryable, id: string): Promise<Message | null> {
    const r = await db.query("SELECT * FROM messages WHERE id = $1", [id]);
    return r.rows[0] ? messageFromRow(r.rows[0]) : null;
  },
};

/* ------------------------------------------------------------------ runs & events */

function runFromRow(r: Record<string, unknown>): Run {
  return {
    id: r.id as string,
    teamId: r.team_id as string,
    botId: r.bot_id as string,
    threadId: r.thread_id as string,
    triggerMessageId: (r.trigger_message_id as string | null) ?? null,
    status: r.status as RunStatus,
    provider: r.provider as string,
    model: (r.model as string | null) ?? null,
    engine: (r.engine as string | null) ?? null,
    stopReason: (r.stop_reason as Run["stopReason"]) ?? null,
    usage: (r.usage as UsageSnapshot) ?? {},
    error: (r.error as Run["error"]) ?? null,
    workflowId: r.workflow_id as string,
    traceId: (r.trace_id as string | null) ?? null,
    startedAt: isoReq(r.started_at as Date),
    endedAt: iso(r.ended_at as Date | null),
  };
}

export const runs = {
  /** Idempotent: Temporal may retry the activity that creates a run. */
  async start(db: Queryable, r: { id: string; teamId: string; botId: string; threadId: string; triggerMessageId: string | null; provider: string; model?: string | null; engine?: string | null; workflowId: string; traceId?: string | null }): Promise<Run> {
    const res = await db.query(
      `INSERT INTO runs (id, team_id, bot_id, thread_id, trigger_message_id, status, provider, model, engine, workflow_id, trace_id)
       VALUES ($1, $2, $3, $4, $5, 'running', $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO UPDATE SET provider = EXCLUDED.provider, model = COALESCE(EXCLUDED.model, runs.model), engine = COALESCE(EXCLUDED.engine, runs.engine)
       RETURNING *`,
      [r.id, r.teamId, r.botId, r.threadId, r.triggerMessageId, r.provider, r.model ?? null, r.engine ?? null, r.workflowId, r.traceId ?? null],
    );
    return runFromRow(res.rows[0]);
  },
  async setInput(db: Queryable, id: string, input: Record<string, unknown>): Promise<void> {
    await db.query("UPDATE runs SET input = $2 WHERE id = $1", [id, JSON.stringify(input)]);
  },
  async getInput<T = Record<string, unknown>>(db: Queryable, id: string): Promise<T | null> {
    const r = await db.query("SELECT input FROM runs WHERE id = $1", [id]);
    return (r.rows[0]?.input as T | undefined) ?? null;
  },
  async setTraceId(db: Queryable, id: string, traceId: string): Promise<void> {
    await db.query("UPDATE runs SET trace_id = $2 WHERE id = $1", [id, traceId]);
  },
  async setStatus(db: Queryable, id: string, status: RunStatus): Promise<void> {
    await db.query("UPDATE runs SET status = $2 WHERE id = $1 AND status NOT IN ('completed','failed','cancelled')", [id, status]);
  },
  async finish(db: Queryable, id: string, f: { status: RunStatus; stopReason?: string | null; usage?: UsageSnapshot; error?: { code: string; message: string } | null; model?: string | null }): Promise<void> {
    await db.query("UPDATE runs SET status = $2, stop_reason = $3, usage = $4, error = $5, model = COALESCE($6, model), ended_at = now() WHERE id = $1", [
      id,
      f.status,
      f.stopReason ?? null,
      JSON.stringify(f.usage ?? {}),
      f.error ? JSON.stringify(f.error) : null,
      f.model ?? null,
    ]);
  },
  async get(db: Queryable, teamId: string, id: string): Promise<Run | null> {
    const r = await db.query("SELECT * FROM runs WHERE id = $1 AND team_id = $2", [id, teamId]);
    return r.rows[0] ? runFromRow(r.rows[0]) : null;
  },
  async getById(db: Queryable, id: string): Promise<Run | null> {
    const r = await db.query("SELECT * FROM runs WHERE id = $1", [id]);
    return r.rows[0] ? runFromRow(r.rows[0]) : null;
  },
  async listForThread(db: Queryable, threadId: string, limit = 50): Promise<Run[]> {
    const r = await db.query("SELECT * FROM runs WHERE thread_id = $1 ORDER BY started_at DESC LIMIT $2", [threadId, limit]);
    return r.rows.map(runFromRow);
  },
  async active(db: Queryable, teamId: string): Promise<Run[]> {
    const r = await db.query("SELECT * FROM runs WHERE team_id = $1 AND status IN ('queued','running','waiting_approval') ORDER BY started_at DESC", [teamId]);
    return r.rows.map(runFromRow);
  },
};

export const EVENTS_CHANNEL = "orrery_run_events";

export const events = {
  async nextSeq(db: Queryable, runId: string): Promise<number> {
    const r = await db.query<{ s: number }>("SELECT coalesce(max(seq), 0) + 1 AS s FROM run_events WHERE run_id = $1", [runId]);
    return Number(r.rows[0]?.s ?? 1);
  },
  /** Batch append; idempotent on (run_id, seq). Notifies live listeners (SSE) after insert. */
  async append(db: Queryable, batch: Array<{ runId: string; seq: number; teamId: string; botId: string; threadId: string; event: AgentEvent }>): Promise<void> {
    if (!batch.length) return;
    const values: unknown[] = [];
    const rows: string[] = [];
    batch.forEach((e, i) => {
      const b = i * 7;
      rows.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7})`);
      values.push(e.runId, e.seq, e.teamId, e.botId, e.threadId, e.event.type, JSON.stringify(e.event));
    });
    await db.query(`INSERT INTO run_events (run_id, seq, team_id, bot_id, thread_id, type, event) VALUES ${rows.join(",")} ON CONFLICT (run_id, seq) DO NOTHING`, values);
    const last = batch[batch.length - 1]!;
    await db.query("SELECT pg_notify($1, $2)", [EVENTS_CHANNEL, JSON.stringify({ runId: last.runId, threadId: last.threadId, teamId: last.teamId, seq: last.seq })]);
  },
  async listForRun(db: Queryable, runId: string, afterSeq = 0, limit = 5000): Promise<RunEventEnvelope[]> {
    const r = await db.query("SELECT * FROM run_events WHERE run_id = $1 AND seq > $2 ORDER BY seq LIMIT $3", [runId, afterSeq, limit]);
    return r.rows.map((x) => ({ id: `${x.run_id}:${x.seq}`, runId: x.run_id, threadId: x.thread_id, botId: x.bot_id, seq: x.seq, ts: isoReq(x.ts), event: x.event as AgentEvent }));
  },
};

export const steering = {
  async add(db: Queryable, runId: string, parts: ContentPart[], by: string): Promise<number> {
    const r = await db.query<{ id: string }>("INSERT INTO steering (run_id, parts, created_by) VALUES ($1, $2, $3) RETURNING id", [runId, JSON.stringify(parts), by]);
    await db.query("SELECT pg_notify('orrery_steering', $1)", [runId]);
    return Number(r.rows[0]!.id);
  },
  async takePending(db: Queryable, runId: string): Promise<Array<{ id: number; parts: ContentPart[] }>> {
    const r = await db.query("UPDATE steering SET consumed = true WHERE run_id = $1 AND NOT consumed RETURNING id, parts", [runId]);
    return r.rows.map((x) => ({ id: Number(x.id), parts: x.parts as ContentPart[] }));
  },
};

/* ------------------------------------------------------------------ approvals */

function approvalFromRow(r: Record<string, unknown>): Approval {
  return {
    id: r.id as string,
    teamId: r.team_id as string,
    botId: r.bot_id as string,
    threadId: r.thread_id as string,
    runId: r.run_id as string,
    toolCallId: r.tool_call_id as string,
    title: r.title as string,
    kind: r.kind as Approval["kind"],
    capability: r.capability as string,
    resource: r.resource as string,
    rawInput: r.raw_input,
    options: r.options as Approval["options"],
    consent: (r.consent as Approval["consent"]) ?? null,
    mcpTool: (r.mcp_tool as Approval["mcpTool"]) ?? null,
    risk: (r.risk as number | null) ?? null,
    status: r.status as ApprovalStatus,
    decision: (r.decision as Approval["decision"]) ?? null,
    createdAt: isoReq(r.created_at as Date),
    expiresAt: isoReq(r.expires_at as Date),
  };
}

export const approvals = {
  async create(db: Queryable, a: Omit<Approval, "status" | "decision" | "createdAt">): Promise<Approval> {
    const r = await db.query(
      `INSERT INTO approvals (id, team_id, bot_id, thread_id, run_id, tool_call_id, title, kind, capability, resource, raw_input, options, consent, mcp_tool, risk, status, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pending',$16)
       ON CONFLICT (id) DO NOTHING RETURNING *`,
      [
        a.id, a.teamId, a.botId, a.threadId, a.runId, a.toolCallId, a.title, a.kind, a.capability, a.resource,
        JSON.stringify(a.rawInput ?? null), JSON.stringify(a.options), a.consent ? JSON.stringify(a.consent) : null, a.mcpTool ? JSON.stringify(a.mcpTool) : null, a.risk, a.expiresAt,
      ],
    );
    if (r.rows[0]) return approvalFromRow(r.rows[0]);
    return (await approvals.getById(db, a.id))!;
  },
  async getById(db: Queryable, id: string): Promise<Approval | null> {
    const r = await db.query("SELECT * FROM approvals WHERE id = $1", [id]);
    return r.rows[0] ? approvalFromRow(r.rows[0]) : null;
  },
  async get(db: Queryable, teamId: string, id: string): Promise<Approval | null> {
    const r = await db.query("SELECT * FROM approvals WHERE id = $1 AND team_id = $2", [id, teamId]);
    return r.rows[0] ? approvalFromRow(r.rows[0]) : null;
  },
  async listPending(db: Queryable, teamId: string, botId?: string): Promise<Approval[]> {
    const r = await db.query(`SELECT * FROM approvals WHERE team_id = $1 AND status = 'pending' ${botId ? "AND bot_id = $2" : ""} ORDER BY created_at DESC LIMIT 200`, botId ? [teamId, botId] : [teamId]);
    return r.rows.map(approvalFromRow);
  },
  /** Compare-and-set: only a pending approval can be decided (first decision wins). */
  async decide(db: Queryable, id: string, status: Exclude<ApprovalStatus, "pending">, decision: NonNullable<Approval["decision"]>): Promise<Approval | null> {
    const r = await db.query("UPDATE approvals SET status = $2, decision = $3 WHERE id = $1 AND status = 'pending' RETURNING *", [id, status, JSON.stringify(decision)]);
    if (r.rows[0]) await db.query("SELECT pg_notify('orrery_approvals', $1)", [id]);
    return r.rows[0] ? approvalFromRow(r.rows[0]) : null;
  },
  async cancelForRun(db: Queryable, runId: string): Promise<void> {
    await db.query("UPDATE approvals SET status = 'cancelled' WHERE run_id = $1 AND status = 'pending'", [runId]);
  },
};

/* ------------------------------------------------------------------ knowledge */

function kbFromRow(r: Record<string, unknown>): KnowledgeBase {
  return {
    id: r.id as string,
    teamId: r.team_id as string,
    name: r.name as string,
    description: r.description as string,
    embeddingModel: r.embedding_model as string,
    embeddingDims: r.embedding_dims as number,
    chunkSize: r.chunk_size as number,
    chunkOverlap: r.chunk_overlap as number,
    createdAt: isoReq(r.created_at as Date),
  };
}

function sourceFromRow(r: Record<string, unknown>): KnowledgeSource {
  return {
    id: r.id as string,
    knowledgeBaseId: r.knowledge_base_id as string,
    type: r.type as KnowledgeSource["type"],
    uri: r.uri as string,
    title: r.title as string,
    mimeType: (r.mime_type as string | null) ?? null,
    status: r.status as KnowledgeSource["status"],
    error: (r.error as string | null) ?? null,
    stats: (r.stats as KnowledgeSource["stats"]) ?? {},
    createdAt: isoReq(r.created_at as Date),
    updatedAt: isoReq(r.updated_at as Date),
  };
}

export const knowledge = {
  async createBase(db: Queryable, k: Omit<KnowledgeBase, "id" | "createdAt">): Promise<KnowledgeBase> {
    const r = await db.query(
      "INSERT INTO knowledge_bases (id, team_id, name, description, embedding_model, embedding_dims, chunk_size, chunk_overlap) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
      [newId("knowledgeBase"), k.teamId, k.name, k.description, k.embeddingModel, k.embeddingDims, k.chunkSize, k.chunkOverlap],
    );
    return kbFromRow(r.rows[0]);
  },
  async listBases(db: Queryable, teamId: string): Promise<KnowledgeBase[]> {
    return (await db.query("SELECT * FROM knowledge_bases WHERE team_id = $1 ORDER BY created_at", [teamId])).rows.map(kbFromRow);
  },
  async getBase(db: Queryable, id: string): Promise<KnowledgeBase | null> {
    const r = await db.query("SELECT * FROM knowledge_bases WHERE id = $1", [id]);
    return r.rows[0] ? kbFromRow(r.rows[0]) : null;
  },
  async addSource(db: Queryable, s: { knowledgeBaseId: string; type: KnowledgeSource["type"]; uri: string; title: string; mimeType?: string | null; content?: Buffer | null }): Promise<KnowledgeSource> {
    const r = await db.query(
      "INSERT INTO knowledge_sources (id, knowledge_base_id, type, uri, title, mime_type, content, status) VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING *",
      [newId("source"), s.knowledgeBaseId, s.type, s.uri, s.title, s.mimeType ?? null, s.content ?? null],
    );
    return sourceFromRow(r.rows[0]);
  },
  async getSource(db: Queryable, id: string): Promise<(KnowledgeSource & { content: Buffer | null; contentHash: string | null }) | null> {
    const r = await db.query("SELECT * FROM knowledge_sources WHERE id = $1", [id]);
    const row = r.rows[0];
    return row ? { ...sourceFromRow(row), content: (row.content as Buffer | null) ?? null, contentHash: (row.content_hash as string | null) ?? null } : null;
  },
  async listSources(db: Queryable, kbId: string): Promise<KnowledgeSource[]> {
    return (await db.query("SELECT id, knowledge_base_id, type, uri, title, mime_type, status, error, stats, created_at, updated_at FROM knowledge_sources WHERE knowledge_base_id = $1 ORDER BY created_at", [kbId])).rows.map(sourceFromRow);
  },
  async setSourceStatus(db: Queryable, id: string, status: KnowledgeSource["status"], extra: { error?: string | null; stats?: KnowledgeSource["stats"]; contentHash?: string | null } = {}): Promise<void> {
    await db.query("UPDATE knowledge_sources SET status = $2, error = $3, stats = COALESCE($4, stats), content_hash = COALESCE($5, content_hash), updated_at = now() WHERE id = $1", [
      id,
      status,
      extra.error ?? null,
      extra.stats ? JSON.stringify(extra.stats) : null,
      extra.contentHash ?? null,
    ]);
  },
  async deleteSource(db: Queryable, id: string): Promise<void> {
    await db.query("DELETE FROM knowledge_sources WHERE id = $1", [id]);
  },
};

/* ------------------------------------------------------------------ routines */

function routineFromRow(r: Record<string, unknown>): Routine {
  return {
    id: r.id as string,
    teamId: r.team_id as string,
    botId: r.bot_id as string,
    name: r.name as string,
    prompt: r.prompt as string,
    schedule: r.schedule as Routine["schedule"],
    threadPolicy: r.thread_policy as Routine["threadPolicy"],
    threadId: (r.thread_id as string | null) ?? null,
    enabled: r.enabled as boolean,
    lastRunAt: iso(r.last_run_at as Date | null),
    createdAt: isoReq(r.created_at as Date),
  };
}

export const routines = {
  async create(db: Queryable, teamId: string, r: Omit<Routine, "id" | "teamId" | "threadId" | "lastRunAt" | "createdAt">): Promise<Routine> {
    const res = await db.query("INSERT INTO routines (id, team_id, bot_id, name, prompt, schedule, thread_policy, enabled) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *", [
      newId("routine"),
      teamId,
      r.botId,
      r.name,
      r.prompt,
      JSON.stringify(r.schedule),
      r.threadPolicy,
      r.enabled,
    ]);
    return routineFromRow(res.rows[0]);
  },
  async list(db: Queryable, teamId: string, botId?: string): Promise<Routine[]> {
    const r = await db.query(`SELECT * FROM routines WHERE team_id = $1 ${botId ? "AND bot_id = $2" : ""} ORDER BY created_at`, botId ? [teamId, botId] : [teamId]);
    return r.rows.map(routineFromRow);
  },
  async getById(db: Queryable, id: string): Promise<Routine | null> {
    const r = await db.query("SELECT * FROM routines WHERE id = $1", [id]);
    return r.rows[0] ? routineFromRow(r.rows[0]) : null;
  },
  async update(db: Queryable, teamId: string, id: string, patch: Partial<Pick<Routine, "name" | "prompt" | "schedule" | "enabled" | "threadPolicy">>): Promise<Routine | null> {
    const r = await db.query(
      `UPDATE routines SET name = COALESCE($3, name), prompt = COALESCE($4, prompt), schedule = COALESCE($5, schedule), enabled = COALESCE($6, enabled), thread_policy = COALESCE($7, thread_policy)
       WHERE id = $1 AND team_id = $2 RETURNING *`,
      [id, teamId, patch.name ?? null, patch.prompt ?? null, patch.schedule ? JSON.stringify(patch.schedule) : null, patch.enabled ?? null, patch.threadPolicy ?? null],
    );
    return r.rows[0] ? routineFromRow(r.rows[0]) : null;
  },
  async markRun(db: Queryable, id: string, threadId: string): Promise<void> {
    await db.query("UPDATE routines SET last_run_at = now(), thread_id = $2 WHERE id = $1", [id, threadId]);
  },
  async delete(db: Queryable, teamId: string, id: string): Promise<boolean> {
    return ((await db.query("DELETE FROM routines WHERE id = $1 AND team_id = $2", [id, teamId])).rowCount ?? 0) > 0;
  },
};

/* ------------------------------------------------------------------ delegation, computers, usage, audit */

export const delegations = {
  async create(db: Queryable, d: { teamId: string; fromBotId: string; fromThreadId: string; fromRunId: string | null; toBotId: string; request: string }): Promise<string> {
    const id = newId("delegation");
    await db.query("INSERT INTO delegations (id, team_id, from_bot_id, from_thread_id, from_run_id, to_bot_id, request, status) VALUES ($1,$2,$3,$4,$5,$6,$7,'requested')", [
      id, d.teamId, d.fromBotId, d.fromThreadId, d.fromRunId, d.toBotId, d.request,
    ]);
    return id;
  },
  async update(db: Queryable, id: string, u: { status: "running" | "completed" | "failed"; toThreadId?: string; result?: string }): Promise<void> {
    await db.query("UPDATE delegations SET status = $2, to_thread_id = COALESCE($3, to_thread_id), result = COALESCE($4, result), completed_at = CASE WHEN $2 IN ('completed','failed') THEN now() ELSE completed_at END WHERE id = $1", [
      id, u.status, u.toThreadId ?? null, u.result ?? null,
    ]);
  },
  async get(db: Queryable, id: string): Promise<Record<string, unknown> | null> {
    return ((await db.query("SELECT * FROM delegations WHERE id = $1", [id])).rows[0] as Record<string, unknown> | undefined) ?? null;
  },
};

export interface ComputerRow {
  id: string;
  teamId: string;
  botId: string | null;
  shared: boolean;
  status: "provisioning" | "running" | "stopping" | "stopped" | "failed";
  endpoint: string | null;
  agentKind: string;
  image: string | null;
  specHash: string | null;
  lastActiveAt: string;
}

function computerFromRow(r: Record<string, unknown>): ComputerRow {
  return {
    id: r.id as string,
    teamId: r.team_id as string,
    botId: (r.bot_id as string | null) ?? null,
    shared: r.shared as boolean,
    status: r.status as ComputerRow["status"],
    endpoint: (r.endpoint as string | null) ?? null,
    agentKind: r.agent_kind as string,
    image: (r.image as string | null) ?? null,
    specHash: (r.spec_hash as string | null) ?? null,
    lastActiveAt: isoReq(r.last_active_at as Date),
  };
}

export const computers = {
  async forBot(db: Queryable, botId: string): Promise<ComputerRow | null> {
    const r = await db.query("SELECT * FROM computers WHERE bot_id = $1 AND NOT shared", [botId]);
    return r.rows[0] ? computerFromRow(r.rows[0]) : null;
  },
  async get(db: Queryable, id: string): Promise<ComputerRow | null> {
    const r = await db.query("SELECT * FROM computers WHERE id = $1", [id]);
    return r.rows[0] ? computerFromRow(r.rows[0]) : null;
  },
  async upsert(db: Queryable, c: Omit<ComputerRow, "lastActiveAt">): Promise<ComputerRow> {
    const r = await db.query(
      `INSERT INTO computers (id, team_id, bot_id, shared, status, endpoint, agent_kind, image, spec_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, endpoint = EXCLUDED.endpoint, agent_kind = EXCLUDED.agent_kind, image = EXCLUDED.image, spec_hash = EXCLUDED.spec_hash, last_active_at = now()
       RETURNING *`,
      [c.id, c.teamId, c.botId, c.shared, c.status, c.endpoint, c.agentKind, c.image, c.specHash],
    );
    return computerFromRow(r.rows[0]);
  },
  async touch(db: Queryable, id: string): Promise<void> {
    await db.query("UPDATE computers SET last_active_at = now() WHERE id = $1", [id]);
  },
  async setStatus(db: Queryable, id: string, status: ComputerRow["status"]): Promise<void> {
    await db.query("UPDATE computers SET status = $2 WHERE id = $1", [id, status]);
  },
  async idle(db: Queryable, olderThanMinutesByBot: (row: ComputerRow) => number): Promise<ComputerRow[]> {
    const rows = (await db.query("SELECT * FROM computers WHERE status = 'running'")).rows.map(computerFromRow);
    const now = Date.now();
    return rows.filter((r) => now - Date.parse(r.lastActiveAt) > olderThanMinutesByBot(r) * 60_000);
  },
  async list(db: Queryable, teamId: string): Promise<ComputerRow[]> {
    return (await db.query("SELECT * FROM computers WHERE team_id = $1 ORDER BY created_at", [teamId])).rows.map(computerFromRow);
  },
};

export const usage = {
  async record(db: Queryable, u: { runId: string; teamId: string; botId: string; provider: string; model: string | null; usage: UsageSnapshot }): Promise<void> {
    await db.query(
      `INSERT INTO usage_records (run_id, team_id, bot_id, provider, model, input_tokens, output_tokens, credits, cost_usd) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (run_id) DO UPDATE SET input_tokens = EXCLUDED.input_tokens, output_tokens = EXCLUDED.output_tokens, credits = EXCLUDED.credits, cost_usd = EXCLUDED.cost_usd`,
      [u.runId, u.teamId, u.botId, u.provider, u.model, u.usage.inputTokens ?? null, u.usage.outputTokens ?? null, u.usage.metering?.credits ?? null, u.usage.costUsd ?? null],
    );
  },
  async summary(db: Queryable, teamId: string, sinceIso: string): Promise<Array<{ botId: string; provider: string; runs: number; inputTokens: number; outputTokens: number; credits: number; costUsd: number }>> {
    const r = await db.query(
      `SELECT bot_id, provider, count(*)::int AS runs, coalesce(sum(input_tokens),0)::bigint AS input_tokens, coalesce(sum(output_tokens),0)::bigint AS output_tokens,
              coalesce(sum(credits),0)::float AS credits, coalesce(sum(cost_usd),0)::float AS cost_usd
       FROM usage_records WHERE team_id = $1 AND created_at >= $2 GROUP BY bot_id, provider ORDER BY bot_id`,
      [teamId, sinceIso],
    );
    return r.rows.map((x) => ({ botId: x.bot_id, provider: x.provider, runs: x.runs, inputTokens: Number(x.input_tokens), outputTokens: Number(x.output_tokens), credits: x.credits, costUsd: x.cost_usd }));
  },
};

export const audit = {
  async log(db: Queryable, a: { teamId: string; actor: string; action: string; target?: string | null; data?: Record<string, unknown> }): Promise<void> {
    await db.query("INSERT INTO audit_log (id, team_id, actor, action, target, data) VALUES ($1,$2,$3,$4,$5,$6)", [newId("audit"), a.teamId, a.actor, a.action, a.target ?? null, JSON.stringify(a.data ?? {})]);
  },
  async list(db: Queryable, teamId: string, limit = 100): Promise<Array<Record<string, unknown>>> {
    return (await db.query("SELECT * FROM audit_log WHERE team_id = $1 ORDER BY created_at DESC LIMIT $2", [teamId, limit])).rows as Array<Record<string, unknown>>;
  },
};
