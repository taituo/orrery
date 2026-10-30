import { createServer } from "node:http";
import { Runtime, Worker } from "@temporalio/worker";
import { OpenTelemetryActivityInboundInterceptor, OpenTelemetryWorkflowClientInterceptor } from "@temporalio/interceptors-opentelemetry";
import type { ActivityInterceptorsFactory } from "@temporalio/worker";
import YAML from "yaml";
import { loadEnv, loadProviders, taskQueues } from "@orrery/core";
import { PgListener, createPool, migrate, secrets, vectorDims } from "@orrery/db";
import { MemoryService } from "@orrery/memory";
import { KnowledgeService } from "@orrery/rag";
import { ProviderRegistry } from "@orrery/providers";
import { createLogger, initTelemetry } from "@orrery/observability";
import { createAcpActivities } from "./activities/acp.js";
import { createAgentActivities } from "./activities/agent.js";
import { createMemoryActivities } from "./activities/memory.js";
import { LocalComputerProvider, createComputerProvider } from "./computers.js";
import type { WorkerDeps } from "./context.js";
import { McpHub } from "./mcp-hub.js";
import { connectClient, connectNative, ensurePlatformSchedules } from "./temporal.js";
import { workflowBundle } from "./workflow-bundle.js";

/**
 * Orrery worker. One binary, three roles selected by WORKER_QUEUES so each scales on its own:
 *   agent  — workflows + short activities (CPU-light, many)
 *   acp    — long-running ACP turns holding gateway connections (I/O-bound, high concurrency)
 *   memory — embeddings, extraction, consolidation, ingestion (provider-bound)
 */
const env = loadEnv();
const log = createLogger("orrery-worker", env.LOG_LEVEL);
const roles = new Set((process.env.WORKER_QUEUES ?? "agent,acp,memory").split(",").map((s) => s.trim()));
const queues = taskQueues(env.TEMPORAL_TASK_QUEUE_PREFIX);

Runtime.install({
  logger: {
    log: (level, message, meta) => log[level === "TRACE" ? "trace" : level === "DEBUG" ? "debug" : level === "INFO" ? "info" : level === "WARN" ? "warn" : "error"]({ ...meta }, message),
    trace: (m, meta) => log.trace(meta ?? {}, m),
    debug: (m, meta) => log.debug(meta ?? {}, m),
    info: (m, meta) => log.info(meta ?? {}, m),
    warn: (m, meta) => log.warn(meta ?? {}, m),
    error: (m, meta) => log.error(meta ?? {}, m),
  },
  telemetryOptions: { metrics: { prometheus: { bindAddress: `0.0.0.0:${env.METRICS_PORT}` } } },
});

const telemetry = initTelemetry({
  serviceName: "orrery-worker",
  environment: env.DEPLOYMENT_ENV,
  langfuse: { publicKey: env.LANGFUSE_PUBLIC_KEY, secretKey: env.LANGFUSE_SECRET_KEY, baseUrl: env.LANGFUSE_BASE_URL },
  otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
});

const db = createPool({ connectionString: env.DATABASE_URL, max: env.DATABASE_POOL_MAX, ssl: env.DATABASE_SSL, applicationName: "orrery-worker" });
if (process.env.MIGRATE_ON_START === "true") await migrate(db, { log: (m) => log.info(m) });
const dims = await vectorDims(db);
const listener = new PgListener(env.DATABASE_URL, (err) => log.warn({ err: String(err) }, "listener error"));
await listener.start();

const providers = new ProviderRegistry(loadProviders(env, (s) => YAML.parse(s)), { embed: env.EMBED_PROVIDER_ID, fast: env.FAST_PROVIDER_ID, clef: env.CLEF_PROVIDER_ID });
const memory = new MemoryService(db, providers, dims);
const knowledge = new KnowledgeService(db, providers, dims);
const temporal = await connectClient(env, { workflow: [new OpenTelemetryWorkflowClientInterceptor()] });
const computerProvider = createComputerProvider(db, env, log, providers.configs);
const mcp = new McpHub(log, (teamId, value) => secrets.resolve(db, teamId, value, env.ENCRYPTION_KEY));

const deps: WorkerDeps = { env, log, db, listener, providers, memory, knowledge, computers: computerProvider, mcp, temporal, telemetry, queues };

const connection = await connectNative(env);
// Propagate trace context from workflow → activity so provider/DB spans join the turn's trace.
const activityInterceptors: ActivityInterceptorsFactory[] = [(ctx) => ({ inbound: new OpenTelemetryActivityInboundInterceptor(ctx) })];
const workers: Worker[] = [];

if (roles.has("agent")) {
  const bundle = await workflowBundle();
  workers.push(
    await Worker.create({
      connection,
      namespace: env.TEMPORAL_NAMESPACE,
      taskQueue: queues.agent,
      ...bundle,
      activities: createAgentActivities(deps),
      interceptors: { activity: activityInterceptors },
      maxConcurrentActivityTaskExecutions: Number(process.env.AGENT_ACTIVITY_CONCURRENCY ?? 64),
      maxConcurrentWorkflowTaskExecutions: Number(process.env.WORKFLOW_TASK_CONCURRENCY ?? 64),
    }),
  );
  await ensurePlatformSchedules(temporal, queues).catch((err) => log.warn({ err: String(err) }, "could not ensure platform schedules"));
}
if (roles.has("acp")) {
  workers.push(
    await Worker.create({
      connection,
      namespace: env.TEMPORAL_NAMESPACE,
      taskQueue: queues.acp,
      activities: createAcpActivities(deps),
      interceptors: { activity: activityInterceptors },
      // I/O bound: each activity mostly waits on the agent or a human.
      maxConcurrentActivityTaskExecutions: Number(process.env.ACP_ACTIVITY_CONCURRENCY ?? 200),
    }),
  );
}
if (roles.has("memory")) {
  workers.push(
    await Worker.create({
      connection,
      namespace: env.TEMPORAL_NAMESPACE,
      taskQueue: queues.memory,
      activities: createMemoryActivities(deps),
      interceptors: { activity: activityInterceptors },
      maxConcurrentActivityTaskExecutions: Number(process.env.MEMORY_ACTIVITY_CONCURRENCY ?? 8),
    }),
  );
}

let ready = false;
const health = createServer((req, res) => {
  if (req.url === "/healthz") return void res.writeHead(200).end("ok");
  if (req.url === "/readyz") return void res.writeHead(ready ? 200 : 503).end(ready ? "ready" : "starting");
  res.writeHead(404).end();
});
health.listen(Number(process.env.HEALTH_PORT ?? 8081));

log.info({ roles: [...roles], queues, computers: env.COMPUTER_PROVIDER }, "worker starting");
ready = true;

const shutdown = async (signal: string) => {
  log.info({ signal }, "draining workers");
  ready = false;
  for (const w of workers) w.shutdown();
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

try {
  await Promise.all(workers.map((w) => w.run()));
} finally {
  if (computerProvider instanceof LocalComputerProvider) await computerProvider.stopAll();
  await mcp.closeAll();
  await listener.close();
  await db.end();
  await telemetry.shutdown();
  health.close();
  log.info("worker stopped");
}
