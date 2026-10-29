import {
  newId,
  truncate,
  type CoreMemoryBlock,
  type MemoryItem,
  type MemoryKind,
  type MemoryScope,
} from "@orrery/core";
import { toVector, withTx, type Db, type Queryable } from "@orrery/db";
import { q, type DecisionClient, type ProviderRegistry } from "@orrery/providers";
import { looksSecret, rrf, scoreMemory } from "./rank.js";

/**
 * Layered memory for bots.
 *
 *   core       always-in-context blocks (persona / human / notes) — small, editable
 *   semantic   durable facts, preferences, instructions, entities (vector + full text)
 *   procedural "how we do X here" procedures learned from demonstrations
 *   episodic   one record per completed turn; raw material for consolidation + episodic recall
 *
 * Writes are *gated* (worth remembering? sensitive?) and *reconciled* against what is already
 * known (duplicate / refines / contradicts / unrelated) with Clef decisions; contradicted facts
 * are superseded bitemporally (valid_to + superseded_by), never silently overwritten.
 */

export interface MemoryContext {
  teamId: string;
  botId: string;
  userId?: string | null;
  runId?: string | null;
  threadId?: string | null;
}

export interface Candidate {
  kind: MemoryKind;
  content: string;
  importance?: number;
  tags?: string[];
  scope?: MemoryScope;
  pinned?: boolean;
}

export interface WriteOutcome {
  action: "created" | "updated" | "superseded" | "skipped";
  reason: string;
  id?: string;
  supersededId?: string;
  content: string;
  kind: MemoryKind;
}

export interface RecalledMemory {
  id: string;
  kind: MemoryKind;
  content: string;
  score: number;
  pinned: boolean;
  scope: MemoryScope;
  createdAt: string;
}

export interface RecalledEpisode {
  id: string;
  threadId: string;
  summary: string;
  createdAt: string;
  score: number;
}

const MEMORY_KINDS: MemoryKind[] = ["fact", "preference", "instruction", "entity", "procedure", "episode_summary"];

function rowToMemory(r: Record<string, unknown>): MemoryItem {
  const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
  return {
    id: r.id as string,
    teamId: r.team_id as string,
    botId: (r.bot_id as string | null) ?? null,
    userId: (r.user_id as string | null) ?? null,
    scope: r.scope as MemoryScope,
    kind: r.kind as MemoryKind,
    content: r.content as string,
    tags: (r.tags as string[]) ?? [],
    importance: Number(r.importance),
    confidence: Number(r.confidence),
    pinned: Boolean(r.pinned),
    source: (r.source as MemoryItem["source"]) ?? { type: "turn" },
    validFrom: iso(r.valid_from)!,
    validTo: iso(r.valid_to),
    supersededBy: (r.superseded_by as string | null) ?? null,
    accessCount: Number(r.access_count ?? 0),
    lastAccessedAt: iso(r.last_accessed_at),
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  };
}

export class MemoryService {
  constructor(
    private readonly db: Db,
    private readonly providers: ProviderRegistry,
    private readonly vectorDims: number,
  ) {}

  private get decisions(): DecisionClient | null {
    return this.providers.decisions();
  }

  /* ------------------------------------------------------------------ embeddings */

  async embed(texts: string[]): Promise<{ model: string; vectors: number[][] } | null> {
    const m = this.providers.modelFor("embed");
    if (!m || !texts.length) return null;
    try {
      const vectors = await m.client.embed(texts, m.model);
      return { model: m.model, vectors };
    } catch {
      return null; // degrade to full-text only; never fail a turn on embeddings
    }
  }

  /** Visibility filter: the bot's own memories, team-shared ones if allowed, and its user's. */
  private scopeSql(params: unknown[], ctx: { teamId: string; botId: string; userId?: string | null }, shareScope: "bot" | "team"): string {
    params.push(ctx.teamId, ctx.botId);
    const t = params.length - 1;
    const b = params.length;
    const clauses = [`(m.scope = 'bot' AND m.bot_id = $${b})`];
    if (shareScope === "team") clauses.push(`m.scope = 'team'`);
    if (ctx.userId) {
      params.push(ctx.userId);
      clauses.push(`(m.scope = 'user' AND m.user_id = $${params.length})`);
    }
    return `m.team_id = $${t} AND m.valid_to IS NULL AND (${clauses.join(" OR ")})`;
  }

  /* ------------------------------------------------------------------ read path */

  async recall(input: {
    teamId: string;
    botId: string;
    userId?: string | null;
    query: string;
    k: number;
    shareScope?: "bot" | "team";
    kinds?: MemoryKind[];
    filterWithDecisions?: boolean;
  }): Promise<RecalledMemory[]> {
    if (input.k <= 0 || !input.query.trim()) return [];
    const share = input.shareScope ?? "bot";
    const pool = Math.max(40, input.k * 5);
    const lists: string[][] = [];
    const byId = new Map<string, MemoryItem>();

    const emb = await this.embed([input.query]);
    if (emb) {
      const params: unknown[] = [];
      const where = this.scopeSql(params, input, share);
      params.push(toVector(emb.vectors[0]!, this.vectorDims), emb.model, pool);
      const kindsSql = input.kinds?.length ? ` AND m.kind = ANY($${params.push(input.kinds)})` : "";
      const r = await this.db.query(
        `SELECT m.* FROM memories m WHERE ${where} AND m.embedding_model = $${params.length - 1}${kindsSql}
         ORDER BY m.embedding <=> $${params.length - 2}::vector LIMIT $${params.length}`,
        params,
      );
      lists.push(r.rows.map((x) => x.id as string));
      for (const row of r.rows) byId.set(row.id as string, rowToMemory(row));
    }

    {
      const params: unknown[] = [];
      const where = this.scopeSql(params, input, share);
      params.push(input.query, pool);
      const kindsSql = input.kinds?.length ? ` AND m.kind = ANY($${params.push(input.kinds)})` : "";
      const r = await this.db.query(
        `SELECT m.*, ts_rank_cd(m.content_tsv, websearch_to_tsquery('simple', $${params.length - 1})) AS rank,
                similarity(m.content, $${params.length - 1}) AS sim
         FROM memories m
         WHERE ${where}${kindsSql} AND (m.content_tsv @@ websearch_to_tsquery('simple', $${params.length - 1}) OR m.content % $${params.length - 1} OR m.pinned)
         ORDER BY m.pinned DESC, rank DESC, sim DESC LIMIT $${params.length}`,
        params,
      );
      lists.push(r.rows.map((x) => x.id as string));
      for (const row of r.rows) byId.set(row.id as string, rowToMemory(row));
    }

    const fused = rrf(lists);
    const max = Math.max(0, ...fused.values());
    let ranked = [...fused.entries()]
      .map(([id, f]) => ({ m: byId.get(id)!, score: scoreMemory(byId.get(id)!, f, max) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(input.k * 2, input.k));

    // Evidence filter: one Clef call scores every candidate's relevance to the query.
    if (input.filterWithDecisions !== false && this.decisions && ranked.length > input.k) {
      try {
        const questions = Object.fromEntries(
          ranked.slice(0, 64).map((x, i) => [`m${i}`, q.noul(`Is memory #${i} useful context for responding to the query? Memory #${i}: ${truncate(x.m.content, 600)}`)]),
        );
        const answers = await this.decisions.decide({ query: truncate(input.query, 2000) }, questions, { fast: true });
        ranked = ranked.filter((x, i) => x.m.pinned || i >= 64 || (answers[`m${i}`]?.noul ?? 1) >= 0.35);
      } catch {
        /* keep heuristic ranking */
      }
    }
    const top = ranked.slice(0, input.k);
    if (top.length) {
      await this.db.query("UPDATE memories SET access_count = access_count + 1, last_accessed_at = now() WHERE id = ANY($1)", [top.map((x) => x.m.id)]);
    }
    return top.map((x) => ({ id: x.m.id, kind: x.m.kind, content: x.m.content, score: Number(x.score.toFixed(4)), pinned: x.m.pinned, scope: x.m.scope, createdAt: x.m.createdAt }));
  }

  async recallEpisodes(input: { teamId: string; botId: string; query: string; k: number; excludeThreadId?: string }): Promise<RecalledEpisode[]> {
    if (input.k <= 0) return [];
    const lists: string[][] = [];
    const byId = new Map<string, RecalledEpisode>();
    const emb = await this.embed([input.query]);
    const base = `team_id = $1 AND bot_id = $2 ${input.excludeThreadId ? "AND thread_id <> $3" : ""}`;
    const baseParams: unknown[] = input.excludeThreadId ? [input.teamId, input.botId, input.excludeThreadId] : [input.teamId, input.botId];
    if (emb) {
      const p = [...baseParams, toVector(emb.vectors[0]!, this.vectorDims), emb.model, input.k * 4];
      const r = await this.db.query(
        `SELECT id, thread_id, coalesce(summary, left(user_text, 300) || ' → ' || left(assistant_text, 300)) AS s, created_at FROM episodes
         WHERE ${base} AND embedding_model = $${p.length - 1} ORDER BY embedding <=> $${p.length - 2}::vector LIMIT $${p.length}`,
        p,
      );
      lists.push(r.rows.map((x) => x.id as string));
      for (const x of r.rows) byId.set(x.id, { id: x.id, threadId: x.thread_id, summary: x.s, createdAt: new Date(x.created_at).toISOString(), score: 0 });
    }
    const p = [...baseParams, input.query, input.k * 4];
    const r = await this.db.query(
      `SELECT id, thread_id, coalesce(summary, left(user_text, 300) || ' → ' || left(assistant_text, 300)) AS s, created_at FROM episodes
       WHERE ${base} AND content_tsv @@ websearch_to_tsquery('simple', $${p.length - 1})
       ORDER BY ts_rank_cd(content_tsv, websearch_to_tsquery('simple', $${p.length - 1})) DESC LIMIT $${p.length}`,
      p,
    );
    lists.push(r.rows.map((x) => x.id as string));
    for (const x of r.rows) byId.set(x.id, { id: x.id, threadId: x.thread_id, summary: x.s, createdAt: new Date(x.created_at).toISOString(), score: 0 });
    const fused = rrf(lists);
    return [...fused.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, input.k)
      .map(([id, s]) => ({ ...byId.get(id)!, score: Number(s.toFixed(4)) }));
  }

  /* ------------------------------------------------------------------ core memory */

  async coreMemory(botId: string): Promise<Record<CoreMemoryBlock, string>> {
    const r = await this.db.query("SELECT block, content FROM core_memory WHERE bot_id = $1", [botId]);
    const out: Record<CoreMemoryBlock, string> = { persona: "", human: "", notes: "" };
    for (const row of r.rows) out[row.block as CoreMemoryBlock] = row.content;
    return out;
  }

  async setCoreMemory(botId: string, block: CoreMemoryBlock, content: string, charLimit: number): Promise<string> {
    const value = content.length > charLimit ? content.slice(content.length - charLimit) : content;
    await this.db.query(
      "INSERT INTO core_memory (bot_id, block, content) VALUES ($1, $2, $3) ON CONFLICT (bot_id, block) DO UPDATE SET content = EXCLUDED.content, updated_at = now()",
      [botId, block, value],
    );
    return value;
  }

  /** Append a line, evicting the oldest lines when over the limit. */
  async appendCoreMemory(botId: string, block: CoreMemoryBlock, line: string, charLimit: number): Promise<string> {
    const current = (await this.coreMemory(botId))[block];
    const lines = [...current.split("\n").filter(Boolean), line.trim()];
    while (lines.join("\n").length > charLimit && lines.length > 1) lines.shift();
    return this.setCoreMemory(botId, block, lines.join("\n"), charLimit);
  }

  /* ------------------------------------------------------------------ write path */

  /** Candidate extraction from a finished turn with the fast model (JSON mode). */
  async extractCandidates(turn: { userText: string; assistantText: string; toolSummary?: string; botName: string }): Promise<Candidate[]> {
    const m = this.providers.modelFor("extract") ?? this.providers.modelFor("fast");
    if (!m) return [];
    const { value } = await m.client.json<{ memories?: Array<{ kind?: string; content?: string; importance?: number; tags?: string[] }> }>({
      model: m.model,
      schemaName: "memories",
      schema: {
        type: "object",
        properties: {
          memories: {
            type: "array",
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["fact", "preference", "instruction", "entity", "procedure"] },
                content: { type: "string" },
                importance: { type: "number" },
                tags: { type: "array", items: { type: "string" } },
              },
              required: ["kind", "content"],
            },
          },
        },
        required: ["memories"],
      },
      messages: [
        {
          role: "system",
          content: `You maintain long-term memory for an AI teammate named ${turn.botName}. From the exchange, extract only durable, reusable knowledge: stable facts about people, projects and systems; explicit preferences; standing instructions ("always…", "never…"); and procedures that worked ("to deploy X, run Y then Z"). Write each as one self-contained sentence in third person. Skip small talk, transient task state, anything already obvious, and anything secret (passwords, keys, tokens). Return {"memories": []} when nothing qualifies.`,
        },
        { role: "user", content: `USER:\n${truncate(turn.userText, 6000)}\n\nASSISTANT:\n${truncate(turn.assistantText, 6000)}${turn.toolSummary ? `\n\nTOOLS USED:\n${truncate(turn.toolSummary, 2000)}` : ""}` },
      ],
    });
    return (value.memories ?? [])
      .filter((x) => typeof x.content === "string" && x.content.trim().length > 3)
      .map((x) => ({
        kind: (MEMORY_KINDS.includes(x.kind as MemoryKind) ? x.kind : "fact") as MemoryKind,
        content: x.content!.trim().slice(0, 1000),
        importance: typeof x.importance === "number" ? Math.min(1, Math.max(0, x.importance)) : 0.5,
        tags: (x.tags ?? []).slice(0, 8),
      }));
  }

  /** Gate, reconcile and persist candidates. */
  async gateAndWrite(ctx: MemoryContext, candidates: Candidate[], source: MemoryItem["source"]["type"] = "turn"): Promise<WriteOutcome[]> {
    const outcomes: WriteOutcome[] = [];
    if (!candidates.length) return outcomes;
    const kept: Candidate[] = [];

    // 1) Gate: worth remembering? sensitive? (one Clef call for the whole batch)
    const decisions = this.decisions;
    let gate: Record<string, { noul?: number; choice?: string; score?: number }> = {};
    if (decisions && source === "turn") {
      try {
        const questions: Record<string, ReturnType<typeof q.noul> | ReturnType<typeof q.score>> = {};
        candidates.slice(0, 20).forEach((c, i) => {
          questions[`keep${i}`] = q.noul(`Is candidate #${i} durable knowledge worth remembering for future conversations (not transient, not trivial)? Candidate #${i}: ${truncate(c.content, 500)}`);
          questions[`secret${i}`] = q.noul(`Does candidate #${i} contain a secret or credential (password, API key, token, private key) or highly sensitive personal data? Candidate #${i}: ${truncate(c.content, 500)}`);
          questions[`imp${i}`] = q.score(`How important is candidate #${i} for doing future work well? Candidate #${i}: ${truncate(c.content, 500)}`, ["trivial", "useful", "important", "critical"]);
        });
        gate = (await decisions.decide({ task: "memory write gate" }, questions, { fast: true })) as typeof gate;
      } catch {
        gate = {};
      }
    }
    candidates.forEach((c, i) => {
      if (looksSecret(c.content) || (gate[`secret${i}`]?.noul ?? 0) >= 0.5) {
        outcomes.push({ action: "skipped", reason: "sensitive", content: c.content, kind: c.kind });
        return;
      }
      if (source === "turn" && (gate[`keep${i}`]?.noul ?? 1) < 0.5) {
        outcomes.push({ action: "skipped", reason: "not durable", content: c.content, kind: c.kind });
        return;
      }
      const imp = gate[`imp${i}`]?.score;
      kept.push({ ...c, importance: typeof imp === "number" ? Math.min(1, 0.25 + imp / 4) : (c.importance ?? 0.5) });
    });
    if (!kept.length) return outcomes;

    // 2) Embed all kept candidates at once.
    const emb = await this.embed(kept.map((c) => c.content));

    // 3) Reconcile each against its nearest neighbours and persist.
    for (let i = 0; i < kept.length; i++) {
      const c = kept[i]!;
      const vec = emb?.vectors[i] ?? null;
      outcomes.push(await this.reconcileAndInsert(ctx, c, vec, emb?.model ?? null, source));
    }
    return outcomes;
  }

  /**
   * Nearest existing memories in the same scope: union of semantic neighbours (pgvector) and
   * lexical neighbours (pg_trgm), so near-duplicates are caught even with weak or missing
   * embeddings. `similarity` is the stronger of the two signals, normalized to 0..1.
   */
  private async neighbours(db: Queryable, ctx: MemoryContext, c: Candidate, vec: number[] | null, model: string | null): Promise<Array<MemoryItem & { similarity: number }>> {
    const scope = c.scope ?? "bot";
    const base: unknown[] = [ctx.teamId, scope, ctx.botId, ctx.userId ?? null];
    const scopeSql = `team_id = $1 AND scope = $2 AND valid_to IS NULL AND (($2 = 'bot' AND bot_id = $3) OR ($2 = 'user' AND user_id = $4) OR $2 = 'team')`;
    const found = new Map<string, MemoryItem & { similarity: number }>();
    if (vec && model) {
      const r = await db.query(
        `SELECT *, 1 - (embedding <=> $5::vector) AS similarity FROM memories WHERE ${scopeSql} AND embedding_model = $6 ORDER BY embedding <=> $5::vector LIMIT 5`,
        [...base, toVector(vec, this.vectorDims), model],
      );
      for (const x of r.rows) if (Number(x.similarity) >= 0.55) found.set(x.id, { ...rowToMemory(x), similarity: Number(x.similarity) });
    }
    const t = await db.query(`SELECT *, similarity(content, $5) AS similarity FROM memories WHERE ${scopeSql} AND similarity(content, $5) >= 0.3 ORDER BY similarity DESC LIMIT 5`, [...base, c.content]);
    for (const x of t.rows) {
      // trigram similarity is lower-scaled than cosine; map 0.3..1 onto 0.55..1
      const sim = 0.55 + ((Number(x.similarity) - 0.3) / 0.7) * 0.45;
      const prev = found.get(x.id);
      if (!prev || prev.similarity < sim) found.set(x.id, { ...rowToMemory(x), similarity: sim });
    }
    return [...found.values()].sort((a, b) => b.similarity - a.similarity);
  }

  private async reconcileAndInsert(ctx: MemoryContext, c: Candidate, vec: number[] | null, model: string | null, source: MemoryItem["source"]["type"]): Promise<WriteOutcome> {
    return withTx(this.db, async (tx) => {
      const near = await this.neighbours(tx, ctx, c, vec, model);
      type Relation = "duplicate" | "refines" | "contradicts" | "unrelated";
      let relation = "unrelated" as Relation;
      let target: (MemoryItem & { similarity: number }) | undefined = near[0];
      if (target) {
        if (target.content.trim().toLowerCase() === c.content.trim().toLowerCase() || target.similarity >= 0.97) relation = "duplicate";
        else if (this.decisions) {
          try {
            const a = await this.decisions.decide(
              { existing: near.map((n, i) => `#${i}: ${n.content}`).join("\n"), candidate: c.content },
              {
                relation: q.choice("How does the candidate relate to the most similar existing memory (#0)?", {
                  duplicate: "Says the same thing; nothing new",
                  refines: "Same subject with more or newer detail that should replace it",
                  contradicts: "Same subject but the facts conflict; the candidate is newer",
                  unrelated: "Different subject; both should be kept",
                }),
              },
              { fast: true },
            );
            relation = a.relation.choice as Relation;
          } catch {
            relation = target.similarity >= 0.92 ? "duplicate" : "unrelated";
          }
        } else {
          relation = target.similarity >= 0.92 ? "duplicate" : "unrelated";
        }
      }

      if (relation === "duplicate" && target) {
        await tx.query("UPDATE memories SET confidence = LEAST(1, confidence + 0.05), importance = GREATEST(importance, $2), updated_at = now() WHERE id = $1", [target.id, c.importance ?? 0.5]);
        return { action: "updated", reason: "duplicate", id: target.id, content: target.content, kind: target.kind };
      }

      const id = newId("memory");
      await tx.query(
        `INSERT INTO memories (id, team_id, bot_id, user_id, scope, kind, content, tags, importance, pinned, source, embedding, embedding_model)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          id,
          ctx.teamId,
          (c.scope ?? "bot") === "team" ? null : ctx.botId,
          (c.scope ?? "bot") === "user" ? (ctx.userId ?? null) : null,
          c.scope ?? "bot",
          c.kind,
          c.content,
          c.tags ?? [],
          c.importance ?? 0.5,
          c.pinned ?? false,
          JSON.stringify({ type: source, ...(ctx.runId ? { runId: ctx.runId } : {}), ...(ctx.threadId ? { threadId: ctx.threadId } : {}) }),
          vec ? toVector(vec, this.vectorDims) : null,
          vec ? model : null,
        ],
      );
      if ((relation === "refines" || relation === "contradicts") && target) {
        await tx.query("UPDATE memories SET valid_to = now(), superseded_by = $2, updated_at = now() WHERE id = $1", [target.id, id]);
        return { action: "superseded", reason: relation, id, supersededId: target.id, content: c.content, kind: c.kind };
      }
      return { action: "created", reason: "new", id, content: c.content, kind: c.kind };
    });
  }

  /* ------------------------------------------------------------------ episodes & consolidation */

  async recordEpisode(e: { teamId: string; botId: string; threadId: string; runId: string; userText: string; assistantText: string; tools: unknown[]; summary?: string | null }): Promise<string> {
    const id = newId("episode");
    const text = e.summary ?? `${truncate(e.userText, 1000)}\n${truncate(e.assistantText, 1000)}`;
    const emb = await this.embed([text]);
    await this.db.query(
      `INSERT INTO episodes (id, team_id, bot_id, thread_id, run_id, user_text, assistant_text, summary, tools, embedding, embedding_model)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id, e.teamId, e.botId, e.threadId, e.runId, truncate(e.userText, 20000), truncate(e.assistantText, 20000), e.summary ?? null, JSON.stringify(e.tools),
        emb ? toVector(emb.vectors[0]!, this.vectorDims) : null, emb?.model ?? null,
      ],
    );
    return id;
  }

  /**
   * Background consolidation (Temporal schedule + after N turns): extract durable memories from
   * unprocessed episodes, decay stale unpinned memories, and expire superseded chains.
   */
  async consolidate(input: { teamId: string; botId: string; botName: string; batch?: number; autoExtract: boolean }): Promise<{ episodes: number; created: number; updated: number; superseded: number; skipped: number; decayed: number }> {
    const stats = { episodes: 0, created: 0, updated: 0, superseded: 0, skipped: 0, decayed: 0 };
    const r = await this.db.query("SELECT * FROM episodes WHERE bot_id = $1 AND NOT processed ORDER BY created_at LIMIT $2", [input.botId, input.batch ?? 25]);
    for (const ep of r.rows) {
      stats.episodes++;
      if (input.autoExtract) {
        const toolSummary = (ep.tools as Array<{ title?: string; status?: string }>).map((t) => `${t.title ?? "tool"} (${t.status ?? "?"})`).join(", ");
        const candidates = await this.extractCandidates({ userText: ep.user_text, assistantText: ep.assistant_text, toolSummary, botName: input.botName }).catch(() => []);
        const outcomes = await this.gateAndWrite({ teamId: input.teamId, botId: input.botId, runId: ep.run_id, threadId: ep.thread_id }, candidates);
        for (const o of outcomes) stats[o.action === "created" ? "created" : o.action === "updated" ? "updated" : o.action === "superseded" ? "superseded" : "skipped"]++;
      }
      await this.db.query("UPDATE episodes SET processed = true WHERE id = $1", [ep.id]);
    }
    const d = await this.db.query(
      `UPDATE memories SET importance = GREATEST(0.05, importance * 0.9), updated_at = now()
       WHERE bot_id = $1 AND NOT pinned AND valid_to IS NULL AND coalesce(last_accessed_at, created_at) < now() - interval '90 days' AND importance > 0.05`,
      [input.botId],
    );
    stats.decayed = d.rowCount ?? 0;
    return stats;
  }

  /* ------------------------------------------------------------------ CRUD (API / tools) */

  async list(teamId: string, filter: { botId?: string; kind?: MemoryKind; includeSuperseded?: boolean; search?: string; limit?: number }): Promise<MemoryItem[]> {
    const params: unknown[] = [teamId];
    const where = ["team_id = $1"];
    if (filter.botId) where.push(`(bot_id = $${params.push(filter.botId)} OR scope = 'team')`);
    if (filter.kind) where.push(`kind = $${params.push(filter.kind)}`);
    if (!filter.includeSuperseded) where.push("valid_to IS NULL");
    if (filter.search) where.push(`(content_tsv @@ websearch_to_tsquery('simple', $${params.push(filter.search)}) OR content ILIKE '%' || $${params.length} || '%')`);
    params.push(filter.limit ?? 200);
    const r = await this.db.query(`SELECT * FROM memories WHERE ${where.join(" AND ")} ORDER BY pinned DESC, importance DESC, created_at DESC LIMIT $${params.length}`, params);
    return r.rows.map(rowToMemory);
  }

  async get(teamId: string, id: string): Promise<MemoryItem | null> {
    const r = await this.db.query("SELECT * FROM memories WHERE id = $1 AND team_id = $2", [id, teamId]);
    return r.rows[0] ? rowToMemory(r.rows[0]) : null;
  }

  async update(teamId: string, id: string, patch: { content?: string; importance?: number; pinned?: boolean; tags?: string[]; kind?: MemoryKind }): Promise<MemoryItem | null> {
    const existing = await this.get(teamId, id);
    if (!existing) return null;
    let vec: string | null = null;
    let model: string | null = null;
    if (patch.content && patch.content !== existing.content) {
      if (looksSecret(patch.content)) throw new Error("memory content looks like a secret; refusing to store it");
      const emb = await this.embed([patch.content]);
      if (emb) {
        vec = toVector(emb.vectors[0]!, this.vectorDims);
        model = emb.model;
      }
    }
    const r = await this.db.query(
      `UPDATE memories SET content = COALESCE($3, content), importance = COALESCE($4, importance), pinned = COALESCE($5, pinned), tags = COALESCE($6, tags), kind = COALESCE($7, kind),
         embedding = CASE WHEN $8::text IS NULL THEN embedding ELSE $8::vector END, embedding_model = COALESCE($9, embedding_model), updated_at = now()
       WHERE id = $1 AND team_id = $2 RETURNING *`,
      [id, teamId, patch.content ?? null, patch.importance ?? null, patch.pinned ?? null, patch.tags ?? null, patch.kind ?? null, vec, model],
    );
    return r.rows[0] ? rowToMemory(r.rows[0]) : null;
  }

  /** Soft delete (keeps history for audit); hard delete is a separate admin operation. */
  async forget(teamId: string, id: string): Promise<boolean> {
    const r = await this.db.query("UPDATE memories SET valid_to = now(), updated_at = now() WHERE id = $1 AND team_id = $2 AND valid_to IS NULL", [id, teamId]);
    return (r.rowCount ?? 0) > 0;
  }

  async purge(teamId: string, id: string): Promise<boolean> {
    const r = await this.db.query("DELETE FROM memories WHERE id = $1 AND team_id = $2", [id, teamId]);
    return (r.rowCount ?? 0) > 0;
  }

  /** Render memory for the agent prompt preamble. */
  static format(core: Record<CoreMemoryBlock, string>, memories: RecalledMemory[], episodes: RecalledEpisode[] = []): string {
    const parts: string[] = [];
    const coreText = (["persona", "human", "notes"] as const)
      .filter((b) => core[b].trim())
      .map((b) => `<${b}>\n${core[b].trim()}\n</${b}>`)
      .join("\n");
    if (coreText) parts.push(`<core_memory>\n${coreText}\n</core_memory>`);
    if (memories.length) parts.push(`<long_term_memory>\n${memories.map((m) => `- [${m.kind}${m.pinned ? ", pinned" : ""}] ${m.content}`).join("\n")}\n</long_term_memory>`);
    if (episodes.length) parts.push(`<related_past_conversations>\n${episodes.map((e) => `- (${e.createdAt.slice(0, 10)}) ${e.summary}`).join("\n")}\n</related_past_conversations>`);
    return parts.join("\n");
  }
}


