import { readFileSync } from "node:fs";
import { Client, Connection, ScheduleOverlapPolicy, type ClientOptions, type ConnectionOptions } from "@temporalio/client";
import { NativeConnection, type NativeConnectionOptions } from "@temporalio/worker";
import type { Env } from "@orrery/core";
import { computerJanitorWorkflow, consolidateMemoryWorkflow, workflowIds } from "@orrery/workflows";

/** Connection options shared by clients and workers (self-hosted mTLS or Temporal Cloud API keys). */
export function temporalConnectionOptions(env: Env): ConnectionOptions & NativeConnectionOptions {
  const tls = env.TEMPORAL_TLS || Boolean(env.TEMPORAL_API_KEY)
    ? {
        ...(env.TEMPORAL_TLS_CERT_PATH && env.TEMPORAL_TLS_KEY_PATH
          ? { clientCertPair: { crt: readFileSync(env.TEMPORAL_TLS_CERT_PATH), key: readFileSync(env.TEMPORAL_TLS_KEY_PATH) } }
          : {}),
      }
    : undefined;
  return {
    address: env.TEMPORAL_ADDRESS,
    ...(tls ? { tls } : {}),
    ...(env.TEMPORAL_API_KEY ? { apiKey: env.TEMPORAL_API_KEY, metadata: { "temporal-namespace": env.TEMPORAL_NAMESPACE } } : {}),
  } as ConnectionOptions & NativeConnectionOptions;
}

export async function connectClient(env: Env, interceptors?: ClientOptions["interceptors"]): Promise<Client> {
  const connection = await Connection.connect(temporalConnectionOptions(env));
  return new Client({ connection, namespace: env.TEMPORAL_NAMESPACE, ...(interceptors ? { interceptors } : {}) });
}

export async function connectNative(env: Env): Promise<NativeConnection> {
  return NativeConnection.connect(temporalConnectionOptions(env));
}

/** Idempotently create platform-wide schedules (janitor). Per-bot schedules are created by the API. */
export async function ensurePlatformSchedules(client: Client, queues: { agent: string }): Promise<void> {
  const id = workflowIds.computerJanitor();
  try {
    await client.schedule.create({
      scheduleId: id,
      spec: { intervals: [{ every: "5 minutes" }] },
      action: { type: "startWorkflow", workflowType: computerJanitorWorkflow, taskQueue: queues.agent, args: [] },
      policies: { overlap: ScheduleOverlapPolicy.SKIP },
    });
  } catch (err) {
    if (!String(err).includes("already")) throw err;
  }
}

export async function ensureConsolidationSchedule(client: Client, queues: { agent: string }, teamId: string, botId: string): Promise<void> {
  try {
    await client.schedule.create({
      scheduleId: workflowIds.consolidateSchedule(botId),
      spec: { cronExpressions: ["17 3 * * *"] },
      action: { type: "startWorkflow", workflowType: consolidateMemoryWorkflow, taskQueue: queues.agent, args: [{ teamId, botId }], workflowId: workflowIds.consolidate(botId) },
      policies: { overlap: ScheduleOverlapPolicy.SKIP },
    });
  } catch (err) {
    if (!String(err).includes("already")) throw err;
  }
}
