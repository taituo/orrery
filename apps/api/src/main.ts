import { OpenTelemetryWorkflowClientInterceptor } from "@temporalio/interceptors-opentelemetry";
import { Client } from "@temporalio/client";
import YAML from "yaml";
import { loadEnv, loadProviders, taskQueues } from "@orrery/core";
import { PgListener, createPool, migrate, vectorDims } from "@orrery/db";
import { MemoryService } from "@orrery/memory";
import { KnowledgeService } from "@orrery/rag";
import { ProviderRegistry } from "@orrery/providers";
import { createLogger, initTelemetry } from "@orrery/observability";
import { createApp } from "./app.js";
import { Authenticator } from "./auth.js";
import { Delivery } from "./delivery.js";
import { createNodeServer } from "./server.js";
import { lazyTemporalConnection } from "./temporal.js";
import { EventHub } from "./sse.js";
import { TemporalWorkflowGateway } from "./workflow-gateway.js";

const env = loadEnv();
const log = createLogger("orrery-api", env.LOG_LEVEL);
const telemetry = initTelemetry({
  serviceName: "orrery-api",
  environment: env.DEPLOYMENT_ENV,
  langfuse: { publicKey: env.LANGFUSE_PUBLIC_KEY, secretKey: env.LANGFUSE_SECRET_KEY, baseUrl: env.LANGFUSE_BASE_URL },
  otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
});

const db = createPool({ connectionString: env.DATABASE_URL, max: env.DATABASE_POOL_MAX, ssl: env.DATABASE_SSL, applicationName: "orrery-api" });
if (process.env.MIGRATE_ON_START === "true") await migrate(db, { log: (m) => log.info(m) });
const dims = await vectorDims(db);
const listener = new PgListener(env.DATABASE_URL, (err) => log.warn({ err: String(err) }, "listener error"));
await listener.start();
const hub = new EventHub(db, listener);
await hub.start();

const providers = new ProviderRegistry(loadProviders(env, (s) => YAML.parse(s)), { embed: env.EMBED_PROVIDER_ID, fast: env.FAST_PROVIDER_ID, clef: env.CLEF_PROVIDER_ID });
const memory = new MemoryService(db, providers, dims);
const knowledge = new KnowledgeService(db, providers, dims);

const connection = lazyTemporalConnection(env);
const temporal = new Client({ connection, namespace: env.TEMPORAL_NAMESPACE, interceptors: { workflow: [new OpenTelemetryWorkflowClientInterceptor()] } });
const workflows = new TemporalWorkflowGateway(temporal, taskQueues(env.TEMPORAL_TASK_QUEUE_PREFIX));

const auth = new Authenticator(env, db);
const delivery = new Delivery(db, workflows, log);
delivery.start();
const { app } = createApp({ env, log, db, delivery, auth, workflows, memory, knowledge, providers, hub, telemetry });
const server = createNodeServer(app, { env, db, memory, knowledge, workflows, log, auth, delivery });
server.listen(env.PORT, () => log.info({ port: env.PORT }, "orrery api listening"));

const shutdown = async (signal: string) => {
  log.info({ signal }, "shutting down");
  server.close();
  delivery.stop();
  hub.stop();
  await listener.close();
  await db.end();
  await connection.close();
  await telemetry.shutdown();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
