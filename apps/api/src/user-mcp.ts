import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { OrreryError, sleep, type Bot, type ContentPart, type Message, type Run } from "@orrery/core";
import { approvals, bots, messages, rooms, runs, threads, type Db } from "@orrery/db";
import type { Logger } from "pino";
import { hasRole, type Principal } from "./auth.js";
import type { Delivery } from "./delivery.js";
import { routeGroupMessage } from "./groups.js";

/**
 * MCP for people: an MCP client (Claude Desktop, Cursor, VS Code, another agent) signed in with
 * an Orrery token can talk to the team's bots and groups, follow conversations and decide
 * approvals. Served on the same `/mcp` endpoint as the platform tools agents get; which tool set
 * a caller sees depends on the token (bot-scoped platform token vs. a person's token).
 */
export interface UserMcpDeps {
  db: Db;
  delivery: Delivery;
  log: Logger;
}

const ACTIVE = new Set(["queued", "running", "waiting_approval"]);

interface Tool {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject<z.ZodRawShape>;
  readOnly: boolean;
  role: "viewer" | "member";
  run(p: Principal, args: Record<string, unknown>): Promise<unknown>;
}

export async function handleUserMcp(deps: UserMcpDeps, p: Principal, req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
  const { db } = deps;

  const findBot = async (ref: string): Promise<Bot> => {
    const all = (await bots.list(db, p.teamId)).filter((b) => b.status !== "archived");
    const hit = all.find((b) => b.id === ref) ?? all.find((b) => b.name.toLowerCase() === ref.toLowerCase()) ?? all.find((b) => b.name.toLowerCase().startsWith(ref.toLowerCase()));
    if (!hit) throw new OrreryError("not_found", `no bot "${ref}". Bots: ${all.map((b) => b.name).join(", ") || "none"}`);
    return hit;
  };

  const textOf = (m: Message) => m.parts.map((x) => (x.type === "text" ? x.text : `[${x.type}]`)).join("");

  /** Wait until the turns started after `before` settle (or need a person), up to `seconds`. */
  const waitForReply = async (threadId: string, before: Set<string>, seconds: number) => {
    const deadline = Date.now() + seconds * 1000;
    let mine: Run[] = [];
    for (;;) {
      mine = (await runs.listForThread(db, threadId, 50)).filter((r) => !before.has(r.id));
      const waiting = mine.filter((r) => r.status === "waiting_approval");
      const settled = mine.length > 0 && mine.every((r) => !ACTIVE.has(r.status));
      if (settled || waiting.length || Date.now() > deadline) break;
      await sleep(500);
    }
    const ids = new Set(mine.map((r) => r.id));
    const replies = (await messages.list(db, threadId, 200)).filter((m) => m.runId && ids.has(m.runId) && (m.role === "assistant" || m.role === "system"));
    const botNames = new Map((await bots.list(db, p.teamId)).map((b) => [b.id, b.name]));
    const pending = (await approvals.listPending(db, p.teamId)).filter((a) => a.threadId === threadId && ids.has(a.runId));
    const status = pending.length ? "waiting_approval" : mine.length && mine.every((r) => !ACTIVE.has(r.status)) ? (mine.some((r) => r.status === "failed") ? "failed" : "completed") : "running";
    return {
      conversation_id: threadId,
      status,
      replies: replies.map((m) => ({ from: m.author.name ?? botNames.get(m.author.id) ?? m.author.id, text: textOf(m) })),
      turns: mine.map((r) => ({ run_id: r.id, bot: botNames.get(r.botId) ?? r.botId, status: r.status, ...(r.error ? { error: r.error.message } : {}) })),
      ...(pending.length
        ? {
            pending_approvals: pending.map((a) => ({ approval_id: a.id, tool: a.title, what: `${a.capability}: ${a.resource}`, options: a.options.map((o) => o.kind) })),
            next: "Decide with decide_approval, then call wait_for_reply.",
          }
        : status === "running"
          ? { next: "Still working: call wait_for_reply to keep waiting." }
          : {}),
    };
  };

  const tools: Tool[] = [
    {
      name: "list_bots",
      title: "List bots",
      description: "The team's bots (AI teammates): name, job description and inference engine.",
      input: z.object({}),
      readOnly: true,
      role: "viewer",
      run: async () =>
        (await bots.list(db, p.teamId))
          .filter((b) => b.status !== "archived")
          .map((b) => ({ id: b.id, name: b.name, description: b.description, status: b.status, engine: b.primary.kind === "kiro-acp" ? `kiro ${b.primary.engine}` : b.primary.kind === "opencode-acp" ? "opencode" : b.primary.kind })),
    },
    {
      name: "list_groups",
      title: "List groups",
      description: "Group conversations: several bots (and people) in one conversation. Bots answer when mentioned (@name); otherwise the lead bot answers.",
      input: z.object({}),
      readOnly: true,
      role: "viewer",
      run: async () => (await rooms.list(db, p.teamId)).map((g) => ({ id: g.id, name: g.name, conversation_id: g.threadId, bots: g.members.map((m) => m.name), lead: g.members.find((m) => m.lead)?.name ?? null })),
    },
    {
      name: "ask_bot",
      title: "Ask a bot",
      description:
        "Send a message to a bot (or a group, by name) and wait for the reply. Continues an existing conversation when conversation_id is given, else starts a new one. If a tool call needs approval the result lists pending_approvals; decide them with decide_approval and call wait_for_reply.",
      input: z.object({
        bot: z.string().min(1).describe("Bot or group name (or id)"),
        message: z.string().min(1).max(100_000),
        conversation_id: z.string().optional().describe("Continue this conversation"),
        wait_seconds: z.number().int().min(0).max(600).default(120).describe("How long to wait for the reply"),
      }),
      readOnly: false,
      role: "member",
      run: async (_p, a) => {
        const args = a as { bot: string; message: string; conversation_id?: string; wait_seconds: number };
        const author = { type: "user" as const, id: p.userId, ...(p.name ? { name: p.name } : {}) };
        const parts: ContentPart[] = [{ type: "text", text: args.message }];
        const group = (await rooms.list(db, p.teamId)).find((g) => g.id === args.bot || g.threadId === args.bot || g.name.toLowerCase() === args.bot.toLowerCase().replace(/^#/, ""));
        if (group) {
          const before = new Set((await runs.listForThread(db, group.threadId, 200)).map((r) => r.id));
          await routeGroupMessage({ db, delivery: deps.delivery }, p, group, parts, author);
          return waitForReply(group.threadId, before, args.wait_seconds);
        }
        const bot = await findBot(args.bot);
        let threadId = args.conversation_id;
        if (threadId) {
          const t = await threads.get(db, p.teamId, threadId);
          if (!t || t.botId !== bot.id) throw new OrreryError("not_found", "conversation not found for that bot");
        } else {
          threadId = (await threads.create(db, { teamId: p.teamId, botId: bot.id, channel: "api", createdBy: p.userId, title: args.message.slice(0, 60) })).id;
        }
        const t = (await threads.get(db, p.teamId, threadId))!;
        const before = new Set((await runs.listForThread(db, threadId, 200)).map((r) => r.id));
        await deps.delivery.submit({ teamId: p.teamId, threadId, role: "user", author, parts }, { threadId, botId: bot.id, teamId: p.teamId, channel: t.channel, author, parts, replyTo: null });
        return waitForReply(threadId, before, args.wait_seconds);
      },
    },
    {
      name: "wait_for_reply",
      title: "Wait for a reply",
      description: "Wait for the running turn(s) of a conversation to finish (or to need an approval) and return the replies of the latest turn.",
      input: z.object({ conversation_id: z.string(), wait_seconds: z.number().int().min(0).max(600).default(120) }),
      readOnly: true,
      role: "viewer",
      run: async (_p, a) => {
        const args = a as { conversation_id: string; wait_seconds: number };
        const t = await threads.get(db, p.teamId, args.conversation_id);
        if (!t) throw new OrreryError("not_found", "conversation not found");
        // The latest user message marks the turn being waited for.
        const all = await runs.listForThread(db, t.id, 200);
        const lastUser = (await messages.list(db, t.id, 200)).filter((m) => m.role === "user").at(-1);
        const before = new Set(all.filter((r) => lastUser && r.startedAt < lastUser.createdAt).map((r) => r.id));
        return waitForReply(t.id, before, args.wait_seconds);
      },
    },
    {
      name: "get_conversation",
      title: "Read a conversation",
      description: "The latest messages of a conversation (bot or group).",
      input: z.object({ conversation_id: z.string(), limit: z.number().int().min(1).max(200).default(30) }),
      readOnly: true,
      role: "viewer",
      run: async (_p, a) => {
        const args = a as { conversation_id: string; limit: number };
        const t = await threads.get(db, p.teamId, args.conversation_id);
        if (!t) throw new OrreryError("not_found", "conversation not found");
        const list = (await messages.list(db, t.id, 500)).slice(-args.limit);
        return { conversation_id: t.id, title: t.title, messages: list.map((m) => ({ from: m.author.name ?? m.author.id, role: m.role, text: textOf(m), at: m.createdAt })) };
      },
    },
    {
      name: "list_conversations",
      title: "List conversations",
      description: "Recent conversations with a bot.",
      input: z.object({ bot: z.string() }),
      readOnly: true,
      role: "viewer",
      run: async (_p, a) => {
        const bot = await findBot((a as { bot: string }).bot);
        return (await threads.list(db, p.teamId, bot.id)).slice(0, 50).map((t) => ({ conversation_id: t.id, title: t.title, channel: t.channel, last_activity: t.lastActivityAt }));
      },
    },
    {
      name: "list_approvals",
      title: "Pending approvals",
      description: "Tool calls waiting for a person's decision.",
      input: z.object({}),
      readOnly: true,
      role: "viewer",
      run: async () => {
        const botNames = new Map((await bots.list(db, p.teamId)).map((b) => [b.id, b.name]));
        return (await approvals.listPending(db, p.teamId)).map((a) => ({ approval_id: a.id, bot: botNames.get(a.botId) ?? a.botId, tool: a.title, what: `${a.capability}: ${a.resource}`, input: a.rawInput, options: a.options.map((o) => o.kind), conversation_id: a.threadId, expires_at: a.expiresAt }));
      },
    },
    {
      name: "decide_approval",
      title: "Decide an approval",
      description: "Allow or reject a pending tool call, using one of the options the agent offered.",
      input: z.object({ approval_id: z.string(), decision: z.enum(["allow_once", "allow_always", "reject"]), note: z.string().max(2000).optional() }),
      readOnly: false,
      role: "member",
      run: async (_p, a) => {
        const args = a as { approval_id: string; decision: "allow_once" | "allow_always" | "reject"; note?: string };
        const ap = await approvals.get(db, p.teamId, args.approval_id);
        if (!ap) throw new OrreryError("not_found", "approval not found");
        if (ap.status !== "pending") return { approval_id: ap.id, status: ap.status, note: "already decided" };
        const kinds = args.decision === "reject" ? ["reject_once", "reject_always"] : [args.decision];
        const opt = kinds.map((k) => ap.options.find((o) => o.kind === k)).find(Boolean);
        if (!opt) throw new OrreryError("bad_request", `the agent did not offer ${args.decision} (offered: ${ap.options.map((o) => o.kind).join(", ")})`);
        if (opt.kind === "allow_always" && !hasRole(p, "admin")) throw new OrreryError("forbidden", "standing permission (allow_always) needs an admin");
        const decided = await approvals.decide(db, ap.id, opt.kind.startsWith("allow") ? "approved" : "denied", { optionId: opt.optionId, optionKind: opt.kind, by: p.userId, at: new Date().toISOString(), ...(args.note ? { note: args.note } : {}) });
        if (!decided) return { approval_id: ap.id, status: "already decided" };
        return { approval_id: ap.id, status: decided.status, conversation_id: ap.threadId, next: "Call wait_for_reply to get the result." };
      },
    },
  ];

  const visible = tools.filter((t) => hasRole(p, t.role));
  const server = new Server(
    { name: "orrery", version: "0.1.0" },
    {
      capabilities: { tools: { listChanged: false } },
      instructions: "Orrery: talk to your team's AI bots and groups, follow their conversations and decide approvals for their tool calls. Start with list_bots, then ask_bot.",
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: visible.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: z.toJSONSchema(t.input, { io: "input" }) as { type: "object" },
      annotations: { readOnlyHint: t.readOnly, destructiveHint: false, idempotentHint: t.readOnly, openWorldHint: false },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (r) => {
    const tool = visible.find((t) => t.name === r.params.name);
    if (!tool) throw new McpError(ErrorCode.InvalidParams, `unknown tool ${r.params.name}`);
    try {
      const args = tool.input.parse(r.params.arguments ?? {});
      const result = await tool.run(p, args);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], structuredContent: Array.isArray(result) ? { items: result } : (result as Record<string, unknown>) };
    } catch (err) {
      deps.log.warn({ tool: tool.name, user: p.userId, err: err instanceof Error ? err.message : String(err) }, "user MCP tool failed");
      const msg = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
    }
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
