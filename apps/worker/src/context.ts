import type { Client } from "@temporalio/client";
import type { Logger } from "pino";
import type { Env, InboundMessage } from "@orrery/core";
import type { Db, PgListener } from "@orrery/db";
import type { MemoryService } from "@orrery/memory";
import type { KnowledgeService } from "@orrery/rag";
import type { ProviderRegistry } from "@orrery/providers";
import type { Telemetry } from "@orrery/observability";
import { botWorkflow, inboundSignal, workflowIds } from "@orrery/workflows";
import type { ComputerProvider } from "./computers.js";
import type { McpHub } from "./mcp-hub.js";

export interface WorkerDeps {
  env: Env;
  log: Logger;
  db: Db;
  listener: PgListener;
  providers: ProviderRegistry;
  memory: MemoryService;
  knowledge: KnowledgeService;
  computers: ComputerProvider;
  mcp: McpHub;
  temporal: Client;
  telemetry: Telemetry;
  queues: { agent: string; acp: string; memory: string };
}

/** Signal-with-start the bot entity workflow: creates it on first message, signals afterwards. */
export async function deliverInbound(deps: Pick<WorkerDeps, "temporal" | "queues">, message: InboundMessage): Promise<void> {
  await deps.temporal.workflow.signalWithStart(botWorkflow, {
    workflowId: workflowIds.bot(message.botId),
    taskQueue: deps.queues.agent,
    args: [{ botId: message.botId, teamId: message.teamId }],
    signal: inboundSignal,
    signalArgs: [message],
  });
}
