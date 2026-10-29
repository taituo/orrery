import { createServer, type Server } from "node:http";
import { getRequestListener } from "@hono/node-server";
import type { Hono } from "hono";
import { handleMcp, type McpDeps } from "./mcp.js";

const MAX_MCP_BODY = 10 * 1024 * 1024;

/**
 * The HTTP server: `/mcp` (platform MCP, Streamable HTTP) is served on the raw Node request so
 * the MCP SDK transport owns the response; everything else goes to the Hono app.
 */
export function createNodeServer(app: Hono<never> | { fetch: (req: Request) => Response | Promise<Response> }, mcp: McpDeps): Server {
  const honoListener = getRequestListener(app.fetch as (req: Request) => Response | Promise<Response>);
  const server = createServer(async (req, res) => {
    if (req.url === "/mcp" || req.url?.startsWith("/mcp?")) {
      try {
        let body: unknown = undefined;
        if (req.method === "POST") {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const c of req) {
            size += (c as Buffer).length;
            if (size > MAX_MCP_BODY) {
              res.writeHead(413).end();
              return;
            }
            chunks.push(c as Buffer);
          }
          try {
            body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
          } catch {
            res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
            return;
          }
        }
        await handleMcp(mcp, req, res, body);
      } catch (err) {
        mcp.log.error({ err }, "mcp request failed");
        if (!res.headersSent) res.writeHead(500).end();
      }
      return;
    }
    await honoListener(req, res);
  });
  server.requestTimeout = 0; // SSE streams and long MCP tool calls
  server.headersTimeout = 65_000;
  server.keepAliveTimeout = 65_000; // above typical L7 load-balancer idle timeouts
  return server;
}
