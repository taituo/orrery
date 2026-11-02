import { createServer, type IncomingMessage, type Server } from "node:http";
import { WebSocketServer } from "ws";
import { verifyToken } from "@orrery/core";
import { GATEWAY_TOKEN_AUDIENCE, MAX_FRAME_BYTES, WebSocketTransport } from "@orrery/acp";
import type { AcpGateway } from "./gateway.js";

export interface GatewayServerOptions {
  port: number;
  host?: string;
  tokenSecret: string;
  /** How often to ping workers; a worker that misses one pong is disconnected (default 15 s). */
  pingIntervalMs?: number;
  /** Tokens must be minted for this computer (`sub`). */
  computerId: string;
  logger?: { info(o: object, m?: string): void; warn(o: object, m?: string): void };
}

export function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1]!.trim() : null;
}

/**
 * HTTP surface of the gateway:
 *   GET /healthz   liveness (process up)
 *   GET /readyz    readiness (agent initialized)
 *   GET /metrics   Prometheus text
 *   GET /status    JSON status (token required)
 *   WS  /acp       ACP relay (token required, `sub` must match this computer)
 */
export function startGatewayServer(gateway: AcpGateway, opts: GatewayServerOptions): Promise<Server> {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  const authorized = (req: IncomingMessage): boolean => {
    const token = bearer(req);
    if (!token) return false;
    const payload = verifyToken(token, opts.tokenSecret, GATEWAY_TOKEN_AUDIENCE);
    return payload !== null && payload.sub === opts.computerId;
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://gateway");
    if (url.pathname === "/healthz") {
      res.writeHead(200).end("ok");
      return;
    }
    if (url.pathname === "/readyz") {
      if (gateway.isReady) res.writeHead(200).end("ready");
      else if (gateway.lastError) res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ ready: false, error: gateway.lastError }));
      else res.writeHead(503).end("starting");
      return;
    }
    if (url.pathname === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" }).end(gateway.metrics());
      return;
    }
    if (url.pathname === "/status") {
      if (!authorized(req)) {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...gateway.status(), idle: gateway.idle }));
      return;
    }
    res.writeHead(404).end();
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://gateway");
    if (url.pathname !== "/acp" || !authorized(req)) {
      opts.logger?.warn({ path: url.pathname, remote: req.socket.remoteAddress }, "rejected upgrade");
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      alive.set(ws, true);
      ws.on("pong", () => alive.set(ws, true));
      gateway.attachUpstream(new WebSocketTransport(ws), { remote: req.socket.remoteAddress ?? "?" });
    });
  });

  // Keepalive so idle connections through proxies/LBs are not dropped mid-turn, and dead-peer
  // detection: a worker whose pod vanished never closes its socket, so one that misses a pong
  // is terminated (its sessions and held requests then go to the next worker that attaches).
  const alive = new WeakMap<object, boolean>();
  const ping = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, opts.pingIntervalMs ?? 15_000);
  ping.unref();
  server.on("close", () => clearInterval(ping));

  return new Promise((resolve) => server.listen(opts.port, opts.host ?? "0.0.0.0", () => resolve(server)));
}
