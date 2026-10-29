import pino, { type Logger } from "pino";
import { trace, type Tracer } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { LangfuseClient } from "@langfuse/client";

export * from "./turn-tracer.js";
export { startActiveObservation, startObservation, updateActiveObservation, getActiveTraceId, propagateAttributes } from "@langfuse/tracing";

export function createLogger(name: string, level = process.env.LOG_LEVEL ?? "info"): Logger {
  return pino({
    name,
    level,
    // Never log secrets or OAuth URLs (Kiro: "access tokens and OAuth URLs never enter logs").
    redact: {
      paths: ["*.authorization", "*.token", "*.accessToken", "*.apiKey", "*.password", "headers.authorization", "*.oauthUrl", "*.url"],
      censor: "[redacted]",
    },
    base: { service: name, env: process.env.DEPLOYMENT_ENV ?? "dev" },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export interface TelemetryOptions {
  serviceName: string;
  serviceVersion?: string;
  environment?: string;
  langfuse?: { publicKey?: string | undefined; secretKey?: string | undefined; baseUrl?: string | undefined };
  /** Generic OTLP/HTTP collector (Tempo, Jaeger, Datadog...) in addition to Langfuse. */
  otlpEndpoint?: string | undefined;
}

export interface Telemetry {
  tracer: Tracer;
  langfuseEnabled: boolean;
  langfuse: LangfuseClient | null;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * OpenTelemetry is the single tracing pipeline: Langfuse receives LLM/agent spans through its
 * span processor (it filters to GenAI spans), while an optional OTLP exporter gets everything
 * (HTTP, Temporal, DB) for infrastructure tracing. One trace id ties both together.
 */
export function initTelemetry(opts: TelemetryOptions): Telemetry {
  const processors: SpanProcessor[] = [];
  const lf = opts.langfuse;
  const langfuseEnabled = Boolean(lf?.publicKey && lf?.secretKey);
  if (langfuseEnabled) {
    processors.push(
      new LangfuseSpanProcessor({
        publicKey: lf!.publicKey!,
        secretKey: lf!.secretKey!,
        ...(lf!.baseUrl ? { baseUrl: lf!.baseUrl } : {}),
        environment: opts.environment ?? "dev",
        ...(opts.serviceVersion ? { release: opts.serviceVersion } : {}),
      }),
    );
  }
  if (opts.otlpEndpoint) {
    processors.push(new BatchSpanProcessor(new OTLPTraceExporter({ url: `${opts.otlpEndpoint.replace(/\/+$/, "")}/v1/traces` })));
  }
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: opts.serviceName, [ATTR_SERVICE_VERSION]: opts.serviceVersion ?? "0.1.0", "deployment.environment": opts.environment ?? "dev" }),
    spanProcessors: processors,
  });
  provider.register();
  const langfuse = langfuseEnabled ? new LangfuseClient({ publicKey: lf!.publicKey!, secretKey: lf!.secretKey!, ...(lf!.baseUrl ? { baseUrl: lf!.baseUrl } : {}) }) : null;
  return {
    tracer: trace.getTracer(opts.serviceName),
    langfuseEnabled,
    langfuse,
    flush: async () => {
      await provider.forceFlush();
      await langfuse?.flush().catch(() => undefined);
    },
    shutdown: async () => {
      await provider.shutdown();
      await langfuse?.shutdown().catch(() => undefined);
    },
  };
}

/** Human feedback (thumbs, ratings) on a run → Langfuse score on its trace. */
export function scoreTrace(lf: LangfuseClient | null, input: { traceId: string; name: string; value: number; comment?: string; sessionId?: string }): void {
  if (!lf) return;
  lf.score.create({
    traceId: input.traceId,
    name: input.name,
    value: input.value,
    ...(input.comment ? { comment: input.comment } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  });
}

/** Deep link to a trace in the Langfuse UI. */
export function langfuseTraceUrl(uiBase: string | undefined, traceId: string | null | undefined): string | null {
  if (!uiBase || !traceId) return null;
  return `${uiBase.replace(/\/+$/, "")}/trace/${traceId}`;
}
