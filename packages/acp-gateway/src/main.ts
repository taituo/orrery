import { mkdirSync, readFileSync } from "node:fs";
import pino from "pino";
import { KiroV2Adapter, KiroV3Adapter, StandardAcpAdapter, looksLikeUnsupportedV3Flag, spawnAgent } from "@orrery/acp";
import { AcpGateway, type AgentProcess } from "./gateway.js";
import { startGatewayServer } from "./server.js";

/**
 * Entrypoint inside a bot computer pod.
 *
 * Env:
 *   COMPUTER_ID              required; tokens must be minted for it
 *   GATEWAY_TOKEN_SECRET     shared HMAC secret with the workers
 *   GATEWAY_PORT             default 7777
 *   AGENT_KIND               kiro-v3 (default) | kiro-v2 | kiro-auto | acp
 *   KIRO_CLI_PATH            default "kiro-cli"
 *   KIRO_MODE / KIRO_MODEL   v2 only (launch flags); V3 sets these per session
 *   KIRO_AUTH_METHOD         cli (default) | client
 *   KIRO_API_KEY             headless auth (Pro/Pro+/Power), passed to the CLI process only
 *   KIRO_ACCESS_TOKEN_FILE   with --auth-method=client: file holding a token JSON to answer with
 *   AGENT_COMMAND/AGENT_ARGS generic ACP agent (AGENT_KIND=acp); AGENT_ARGS is a JSON array
 *   WORKSPACE_ROOT           default /home/agent/workspace
 */
const log = pino({ name: "acp-gateway", level: process.env.LOG_LEVEL ?? "info", redact: ["*.token", "*.accessToken", "*.url"] });

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    log.fatal(`${name} is required`);
    process.exit(1);
  }
  return v;
}

const computerId = required("COMPUTER_ID");
const secret = required("GATEWAY_TOKEN_SECRET");
const port = Number(process.env.GATEWAY_PORT ?? 7777);
const kind = process.env.AGENT_KIND ?? "kiro-v3";
const workspace = process.env.WORKSPACE_ROOT ?? "/home/agent/workspace";
mkdirSync(workspace, { recursive: true });

const binding = {
  ...(process.env.KIRO_MODE ? { modeId: process.env.KIRO_MODE } : {}),
  ...(process.env.KIRO_MODEL ? { modelId: process.env.KIRO_MODEL } : {}),
  authMethod: (process.env.KIRO_AUTH_METHOD === "client" ? "client" : "cli") as "cli" | "client",
  ...(process.env.AGENT_COMMAND ? { command: process.env.AGENT_COMMAND } : {}),
  ...(process.env.AGENT_ARGS ? { args: JSON.parse(process.env.AGENT_ARGS) as string[] } : {}),
};
const binary = process.env.KIRO_CLI_PATH ?? "kiro-cli";
// kiro-auto: try the V3 engine first; if this binary predates V3 (rejects the flag), use v2.
let generation: "kiro-v3" | "kiro-v2" | "acp" = kind === "kiro-v2" ? "kiro-v2" : kind === "acp" ? "acp" : "kiro-v3";

const spawn = (): AgentProcess => {
  const adapter = generation === "kiro-v2" ? new KiroV2Adapter() : generation === "acp" ? new StandardAcpAdapter() : new KiroV3Adapter();
  const launch = adapter.launch({ binary, binding });
  // KIRO_CLI_PATH may be "node script.js" in dev: split a leading interpreter.
  const [command, ...prefixArgs] = launch.command.split(" ").filter(Boolean);
  let stderrHead = "";
  const startedAt = Date.now();
  const p = spawnAgent({
    command: command!,
    args: [...prefixArgs, ...launch.args],
    cwd: workspace,
    env: { ...launch.env, HOME: process.env.HOME ?? "/home/agent" },
    onStderr: (line) => {
      if (stderrHead.length < 4000) stderrHead += line + "\n";
      log.info({ agent: "stderr" }, line);
    },
    onParseError: (line) => log.warn({ line: line.slice(0, 200) }, "agent wrote non-JSON to stdout"),
  });
  void p.exited.then(() => {
    if (kind === "kiro-auto" && generation === "kiro-v3" && Date.now() - startedAt < 10_000 && looksLikeUnsupportedV3Flag(stderrHead)) {
      log.warn("kiro-cli does not support --agent-engine=v3; falling back to the CLI v2 ACP server");
      generation = "kiro-v2";
    }
  });
  log.info({ command, args: [...prefixArgs, ...launch.args], pid: p.child.pid, generation }, "agent spawned");
  return { transport: p.transport, pid: p.child.pid ?? null, exited: p.exited, kill: p.kill };
};

const tokenFile = process.env.KIRO_ACCESS_TOKEN_FILE;
const gateway = new AcpGateway({
  spawnAgent: spawn,
  workspaceRoots: [workspace, ...(process.env.EXTRA_WORKSPACE_ROOTS?.split(":").filter(Boolean) ?? [])],
  defaultCwd: workspace,
  logger: log,
  ...(tokenFile ? { accessTokenProvider: async () => JSON.parse(readFileSync(tokenFile, "utf8")) as unknown } : {}),
});

await gateway.start();
const server = await startGatewayServer(gateway, { port, tokenSecret: secret, computerId, logger: log });
log.info({ port, computerId, kind }, "acp gateway listening");

const shutdown = async (signal: string) => {
  log.info({ signal }, "shutting down");
  server.close();
  await gateway.stop();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
