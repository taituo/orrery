import { MemoryKindSchema, OrreryError, truncate, type Bot, type InboundMessage, type MemoryKind } from "@orrery/core";
import { bots, delegations, messages, threads, type Db } from "@orrery/db";
import { MemoryService } from "@orrery/memory";
import { KnowledgeService } from "@orrery/rag";
import { z } from "zod";

/**
 * Platform tools — Orrery capabilities offered to every agent:
 *  - to Kiro (and any ACP agent) through the platform MCP server (`/mcp`, server name "orrery")
 *  - to OpenAI-compatible models through the native tool loop
 * One implementation, two transports. Policy sees them as capability `mcp` / `platform`
 * with resource `orrery/<tool>`.
 */

export interface ToolContext {
  db: Db;
  memory: MemoryService;
  knowledge: KnowledgeService;
  bot: Bot;
  threadId: string | null;
  runId: string | null;
  userId: string | null;
  /** Signal-with-start a bot's entity workflow (delegation). */
  deliverInbound(message: InboundMessage): Promise<void>;
  newId(kind: "message" | "thread"): string;
}

export interface PlatformTool {
  name: string;
  title?: string;
  description: string;
  /** Hint for clients: the tool removes or overwrites data. */
  destructive?: boolean;
  /** JSON Schema of the arguments (also used for MCP and OpenAI function definitions). */
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  run(ctx: ToolContext, args: unknown): Promise<string>;
}

function parse<T>(schema: z.ZodType<T>, args: unknown): T {
  const r = schema.safeParse(args ?? {});
  if (!r.success) throw new OrreryError("bad_request", r.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; "));
  return r.data;
}

function schemaOf(s: z.ZodType): Record<string, unknown> {
  const j = z.toJSONSchema(s, { target: "draft-7", io: "input" }) as Record<string, unknown>;
  delete j.$schema;
  return j;
}

const MemorySearch = z.object({ query: z.string().min(1).describe("What to look for"), k: z.number().int().min(1).max(20).default(6) });
const MemorySave = z.object({
  content: z.string().min(3).max(1000).describe("One self-contained sentence of durable knowledge"),
  kind: MemoryKindSchema.default("fact"),
  importance: z.number().min(0).max(1).default(0.6),
  scope: z.enum(["bot", "team"]).default("bot").describe("team = shared with all bots of the team"),
});
const MemoryForget = z.object({ id: z.string().min(1) });
const CoreAppend = z.object({ block: z.enum(["persona", "human", "notes"]), line: z.string().min(1).max(500) });
const CoreReplace = z.object({ block: z.enum(["persona", "human", "notes"]), content: z.string().max(20000) });
const KnowledgeSearch = z.object({ query: z.string().min(1), k: z.number().int().min(1).max(12).default(5) });
const Delegate = z.object({
  bot: z.string().min(1).describe("Peer bot id or name"),
  task: z.string().min(1).max(20000).describe("Self-contained task description; the peer cannot see this conversation"),
});
const History = z.object({ limit: z.number().int().min(1).max(50).default(20) });

export const PLATFORM_TOOLS: PlatformTool[] = [
  {
    name: "memory_search",
    description: "Search this bot's long-term memory (facts, preferences, instructions, procedures learned in past conversations).",
    inputSchema: schemaOf(MemorySearch),
    readOnly: true,
    async run(ctx, args) {
      const a = parse(MemorySearch, args);
      const hits = await ctx.memory.recall({ teamId: ctx.bot.teamId, botId: ctx.bot.id, userId: ctx.userId, query: a.query, k: a.k, shareScope: ctx.bot.memory.shareScope });
      if (!hits.length) return "No matching memories.";
      return hits.map((h) => `- (${h.id}) [${h.kind}] ${h.content}`).join("\n");
    },
  },
  {
    name: "memory_save",
    description: "Remember something durable for future conversations (a stable fact, a preference, a standing instruction or a procedure that worked). Do not store secrets.",
    inputSchema: schemaOf(MemorySave),
    readOnly: false,
    async run(ctx, args) {
      const a = parse(MemorySave, args);
      const [o] = await ctx.memory.gateAndWrite(
        { teamId: ctx.bot.teamId, botId: ctx.bot.id, userId: ctx.userId, runId: ctx.runId, threadId: ctx.threadId },
        [{ kind: a.kind as MemoryKind, content: a.content, importance: a.importance, scope: a.scope }],
        "tool",
      );
      if (!o) return "Nothing stored.";
      return o.action === "skipped" ? `Not stored (${o.reason}).` : `Memory ${o.action}${o.supersededId ? ` (replaces ${o.supersededId})` : ""}: ${o.id}`;
    },
  },
  {
    name: "memory_forget",
    destructive: true,
    description: "Retire a memory that is wrong or obsolete (it stays in history but is no longer recalled).",
    inputSchema: schemaOf(MemoryForget),
    readOnly: false,
    async run(ctx, args) {
      const a = parse(MemoryForget, args);
      return (await ctx.memory.forget(ctx.bot.teamId, a.id)) ? `Forgot ${a.id}.` : `No active memory ${a.id}.`;
    },
  },
  {
    name: "core_memory_append",
    description: "Append a line to an always-visible core memory block: persona (who you are), human (about the people you work with), notes (scratchpad).",
    inputSchema: schemaOf(CoreAppend),
    readOnly: false,
    async run(ctx, args) {
      const a = parse(CoreAppend, args);
      const v = await ctx.memory.appendCoreMemory(ctx.bot.id, a.block, a.line, ctx.bot.memory.coreMemoryCharLimit);
      return `Core memory "${a.block}" now has ${v.length} characters.`;
    },
  },
  {
    name: "core_memory_replace",
    destructive: true,
    description: "Rewrite a core memory block entirely (use to reorganize or remove outdated lines).",
    inputSchema: schemaOf(CoreReplace),
    readOnly: false,
    async run(ctx, args) {
      const a = parse(CoreReplace, args);
      const v = await ctx.memory.setCoreMemory(ctx.bot.id, a.block, a.content, ctx.bot.memory.coreMemoryCharLimit);
      return `Core memory "${a.block}" replaced (${v.length} characters).`;
    },
  },
  {
    name: "knowledge_search",
    description: "Search the knowledge bases attached to this bot (documents, runbooks, wikis). Returns cited passages.",
    inputSchema: schemaOf(KnowledgeSearch),
    readOnly: true,
    async run(ctx, args) {
      const a = parse(KnowledgeSearch, args);
      if (!ctx.bot.knowledgeBaseIds.length) return "No knowledge bases are attached to this bot.";
      const r = await ctx.knowledge.search({ teamId: ctx.bot.teamId, knowledgeBaseIds: ctx.bot.knowledgeBaseIds, query: a.query, k: a.k });
      if (!r.hits.length) return "No relevant passages found.";
      return KnowledgeService.format(r);
    },
  },
  {
    name: "bots_list",
    description: "List the peer bots this bot may delegate work to.",
    inputSchema: { type: "object", properties: {} },
    readOnly: true,
    async run(ctx) {
      const all = await bots.list(ctx.db, ctx.bot.teamId);
      const peers = all.filter((b) => ctx.bot.peers.includes(b.id) && b.status === "active");
      if (!peers.length) return "No peers configured.";
      return peers.map((b) => `- ${b.name} (${b.id}): ${b.description || "no description"}`).join("\n");
    },
  },
  {
    name: "bots_delegate",
    description: "Hand a self-contained task to a peer bot. Runs asynchronously; the result is posted back into this conversation when the peer finishes.",
    inputSchema: schemaOf(Delegate),
    readOnly: false,
    async run(ctx, args) {
      const a = parse(Delegate, args);
      const all = await bots.list(ctx.db, ctx.bot.teamId);
      const peer = all.find((b) => b.id === a.bot || b.name.toLowerCase() === a.bot.toLowerCase());
      if (!peer || !ctx.bot.peers.includes(peer.id)) throw new OrreryError("forbidden", `"${a.bot}" is not a peer of ${ctx.bot.name}`);
      if (!ctx.threadId) throw new OrreryError("bad_request", "delegation needs a conversation to report back to");
      const delegationId = await delegations.create(ctx.db, { teamId: ctx.bot.teamId, fromBotId: ctx.bot.id, fromThreadId: ctx.threadId, fromRunId: ctx.runId, toBotId: peer.id, request: a.task });
      const thread = await threads.create(ctx.db, { teamId: ctx.bot.teamId, botId: peer.id, channel: "peer", createdBy: ctx.bot.id, title: `From ${ctx.bot.name}: ${truncate(a.task, 60)}` });
      const msg = await messages.insert(ctx.db, {
        teamId: ctx.bot.teamId,
        threadId: thread.id,
        role: "peer",
        author: { type: "bot", id: ctx.bot.id, name: ctx.bot.name },
        parts: [{ type: "text", text: a.task }],
        meta: { delegationId },
      });
      await delegations.update(ctx.db, delegationId, { status: "running", toThreadId: thread.id });
      await ctx.deliverInbound({
        messageId: msg.id,
        threadId: thread.id,
        botId: peer.id,
        teamId: ctx.bot.teamId,
        channel: "peer",
        author: { type: "bot", id: ctx.bot.id, name: ctx.bot.name },
        parts: msg.parts,
        replyTo: { botId: ctx.bot.id, threadId: ctx.threadId, delegationId },
        receivedAt: new Date().toISOString(),
      });
      return `Delegated to ${peer.name} (delegation ${delegationId}). The result will arrive in this conversation.`;
    },
  },
  {
    name: "conversation_history",
    description: "Read the most recent messages of the current conversation (useful after the agent session was restarted).",
    inputSchema: schemaOf(History),
    readOnly: true,
    async run(ctx, args) {
      const a = parse(History, args);
      if (!ctx.threadId) return "No conversation.";
      const list = await messages.list(ctx.db, ctx.threadId, a.limit);
      return list.map((m) => `${m.role}${m.author.name ? ` (${m.author.name})` : ""}: ${truncate(m.parts.map((p) => (p.type === "text" ? p.text : `[${p.type}]`)).join(""), 2000)}`).join("\n\n");
    },
  },
];

export function findTool(name: string): PlatformTool | undefined {
  const bare = name.replace(/^orrery[_/]+/, "");
  return PLATFORM_TOOLS.find((t) => t.name === bare);
}

/** OpenAI function definitions for the native loop (namespaced to avoid MCP collisions). */
export function openAiToolDefs(): Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  return PLATFORM_TOOLS.map((t) => ({ type: "function" as const, function: { name: `orrery__${t.name}`, description: t.description, parameters: t.inputSchema } }));
}

/** Audience/claims for bot-scoped MCP tokens. */
export const MCP_TOKEN_AUDIENCE = "orrery-mcp";
export type McpTokenClaims = {
  sub: string; // bot id
  aud: string;
  exp: number;
  team: string;
  thread: string | null;
  user: string | null;
  [k: string]: unknown;
};
