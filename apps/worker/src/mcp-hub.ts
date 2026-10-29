import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { OrreryError, truncate, type Bot, type McpServerConfig } from "@orrery/core";
import type { Logger } from "pino";

/**
 * MCP client connections for the *native* tool loop (OpenAI-compatible models). Kiro talks to
 * MCP servers itself (from inside the bot computer); here the worker does it on the model's
 * behalf. stdio servers are never started on workers — they only run inside bot computers.
 */
export interface McpToolInfo {
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export type SecretResolver = (teamId: string, value: string) => Promise<string>;

export class McpHub {
  private readonly clients = new Map<string, { client: McpClient; tools: McpToolInfo[]; at: number }>();

  constructor(private readonly log: Logger, private readonly resolveSecret: SecretResolver) {}

  private key(bot: Bot, s: McpServerConfig): string {
    return `${bot.id}:${s.name}:${s.type === "stdio" ? s.command : s.url}`;
  }

  private async connect(bot: Bot, s: McpServerConfig): Promise<{ client: McpClient; tools: McpToolInfo[] }> {
    const key = this.key(bot, s);
    const cached = this.clients.get(key);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached;
    if (s.type === "stdio") throw new OrreryError("capability_unsupported", `MCP server "${s.name}" is stdio; it can only run inside a bot computer`);
    const headers: Record<string, string> = {};
    for (const h of s.headers) headers[h.name] = await this.resolveSecret(bot.teamId, h.value);
    const url = new URL(s.url);
    const transport = s.type === "http" ? new StreamableHTTPClientTransport(url, { requestInit: { headers } }) : new SSEClientTransport(url, { requestInit: { headers } });
    const client = new McpClient({ name: "orrery-worker", version: "0.1.0" });
    await client.connect(transport);
    const listed = await client.listTools();
    const tools: McpToolInfo[] = listed.tools.map((t) => ({
      server: s.name,
      name: t.name,
      description: t.description ?? "",
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object" },
      ...(t.annotations ? { annotations: t.annotations as McpToolInfo["annotations"] } : {}),
    }));
    const entry = { client, tools, at: Date.now() };
    this.clients.set(key, entry);
    return entry;
  }

  /** Tools of all non-stdio MCP servers attached to the bot, as OpenAI function definitions. */
  async toolDefs(bot: Bot): Promise<Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }>> {
    const out: Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }> = [];
    for (const s of bot.mcpServers) {
      if (s.type === "stdio") continue;
      try {
        const { tools } = await this.connect(bot, s);
        for (const t of tools) {
          out.push({ type: "function", function: { name: mcpFunctionName(s.name, t.name), description: truncate(t.description, 1000), parameters: t.inputSchema } });
        }
      } catch (err) {
        this.log.warn({ bot: bot.id, server: s.name, err: err instanceof Error ? err.message : String(err) }, "MCP server unavailable");
      }
    }
    return out;
  }

  async call(bot: Bot, server: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ ok: boolean; text: string }> {
    const s = bot.mcpServers.find((x) => x.name === server);
    if (!s) throw new OrreryError("not_found", `MCP server ${server} is not attached to this bot`);
    const { client } = await this.connect(bot, s);
    const res = await client.callTool({ name: tool, arguments: args }, undefined, signal ? { signal } : undefined);
    const content = (res.content as Array<{ type: string; text?: string }> | undefined) ?? [];
    const text = content.map((c) => (c.type === "text" ? c.text ?? "" : `[${c.type}]`)).join("\n");
    return { ok: !res.isError, text: text || JSON.stringify(res.structuredContent ?? null) };
  }

  async closeAll(): Promise<void> {
    for (const { client } of this.clients.values()) await client.close().catch(() => undefined);
    this.clients.clear();
  }
}

export function mcpFunctionName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

export function parseFunctionName(name: string): { kind: "platform"; tool: string } | { kind: "mcp"; server: string; tool: string } | null {
  if (name.startsWith("orrery__")) return { kind: "platform", tool: name.slice("orrery__".length) };
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? { kind: "mcp", server: m[1]!, tool: m[2]! } : null;
}
