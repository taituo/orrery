import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { newId, verifyToken, type Env } from "@orrery/core";
import { bots, type Db } from "@orrery/db";
import type { MemoryService } from "@orrery/memory";
import type { KnowledgeService } from "@orrery/rag";
import { MCP_TOKEN_AUDIENCE, PLATFORM_TOOLS, type McpTokenClaims, type ToolContext } from "@orrery/tools";
import type { Logger } from "pino";
import type { WorkflowGateway } from "./workflow-gateway.js";
import type { Authenticator } from "./auth.js";
import type { Delivery } from "./delivery.js";
import { handleUserMcp } from "./user-mcp.js";

/**
 * The Orrery platform MCP server ("orrery"), exposed to agents running in bot computers.
 * Kiro (or any ACP agent) receives it in `session/new` / `session/load` as an HTTP MCP server
 * with a bot-scoped bearer token, so memory, knowledge and delegation are first-class tools
 * inside Kiro's own loop — governed by the same permission policy as every other tool.
 *
 * Stateless Streamable HTTP: a fresh server+transport per request (horizontally scalable).
 */
export interface McpDeps {
  env: Env;
  db: Db;
  memory: MemoryService;
  knowledge: KnowledgeService;
  workflows: WorkflowGateway;
  log: Logger;
  /** People's tokens (API tokens, admin token, OIDC) get the user tool set (see user-mcp.ts). */
  auth?: Authenticator;
  delivery?: Delivery;
}

export async function handleMcp(deps: McpDeps, req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
  const auth = req.headers.authorization;
  const token = /^Bearer\s+(.+)$/i.exec(auth ?? "")?.[1];
  const claims = token ? verifyToken<McpTokenClaims>(token, deps.env.MCP_TOKEN_SECRET, MCP_TOKEN_AUDIENCE) : null;
  if (!claims && token && deps.auth && deps.delivery) {
    const person = await deps.auth.authenticateToken(token).catch(() => null);
    if (person) return handleUserMcp({ db: deps.db, delivery: deps.delivery, log: deps.log }, person, req, res, body);
  }
  if (!claims) {
    res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" }).end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  const bot = await bots.getById(deps.db, claims.sub);
  if (!bot || bot.teamId !== claims.team || bot.status === "archived") {
    res.writeHead(403).end();
    return;
  }

  const ctxFor = async (): Promise<ToolContext> => {
    const run = claims.thread
      ? (await deps.db.query("SELECT id FROM runs WHERE thread_id = $1 AND status IN ('running','waiting_approval') ORDER BY started_at DESC LIMIT 1", [claims.thread])).rows[0]
      : undefined;
    return {
      db: deps.db,
      memory: deps.memory,
      knowledge: deps.knowledge,
      bot,
      threadId: claims.thread,
      runId: (run?.id as string | undefined) ?? null,
      userId: claims.user,
      deliverInbound: (m) => deps.workflows.deliver(m),
      newId: (k) => newId(k),
    };
  };

  // Low-level server: tools are advertised with their exact JSON Schemas (enums, arrays and
  // descriptions intact) and validated by the tool's own zod schema on call.
  const tools = PLATFORM_TOOLS.filter((t) => {
    if ((t.name === "bots_delegate" || t.name === "bots_list") && !bot.peers.length) return false;
    if (t.name === "knowledge_search" && !bot.knowledgeBaseIds.length) return false;
    return true;
  });
  const server = new Server(
    { name: "orrery", version: "0.1.0" },
    { capabilities: { tools: { listChanged: false } }, instructions: `Orrery platform tools for ${bot.name}: long-term memory, knowledge bases and peer delegation.` },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      title: t.title ?? t.name,
      description: t.description,
      inputSchema: { type: "object" as const, ...t.inputSchema },
      annotations: { readOnlyHint: t.readOnly, destructiveHint: t.destructive ?? false, idempotentHint: t.readOnly, openWorldHint: false },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find((t) => t.name === req.params.name);
    if (!tool) throw new McpError(ErrorCode.InvalidParams, `unknown tool ${req.params.name}`);
    try {
      const text = await tool.run(await ctxFor(), req.params.arguments ?? {});
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      deps.log.warn({ tool: tool.name, bot: bot.id, err: err instanceof Error ? err.message : String(err) }, "platform tool failed");
      return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
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
