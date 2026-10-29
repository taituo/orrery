import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * Model provider registry. Loaded from PROVIDERS_FILE (YAML/JSON mounted from a ConfigMap) or
 * PROVIDERS_JSON. API keys are never stored here — `apiKeyEnv` names the env var (a K8s Secret).
 */
export const ProviderConfigSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("openai"),
    id: z.string().min(1),
    name: z.string().optional(),
    baseUrl: z.string().url(),
    apiKeyEnv: z.string().optional(),
    headers: z.record(z.string(), z.string()).default({}),
    timeoutMs: z.number().int().positive().default(120_000),
    /** What this endpoint is used for. */
    roles: z.array(z.enum(["chat", "fast", "extract", "summarize", "embed", "rerank"])).min(1),
    models: z
      .object({
        chat: z.array(z.string()).default([]),
        embed: z.string().optional(),
        embedDims: z.number().int().positive().optional(),
        rerank: z.string().optional(),
      })
      .default({ chat: [] }),
    capabilities: z
      .object({ tools: z.boolean().default(true), vision: z.boolean().default(false), jsonSchema: z.boolean().default(true) })
      .default({ tools: true, vision: false, jsonSchema: true }),
    /** Path for the rerank endpoint; Jina/Cohere/TEI style servers differ. */
    rerankPath: z.string().default("/rerank"),
  }),
  z.object({
    kind: z.literal("clef"),
    id: z.string().min(1),
    name: z.string().optional(),
    /** systemone: any `/v1/systemone` server (vLLM, llama.cpp, Ollama, clef-rag serve, TypeSafe).
     *  workers-ai: Cloudflare REST `/client/v4/accounts/{acct}/ai/run/@cf/cloudflare/{model}`. */
    format: z.enum(["systemone", "workers-ai"]),
    baseUrl: z.string().url().optional(),
    accountIdEnv: z.string().optional(),
    apiKeyEnv: z.string().optional(),
    /** Model for high-precision decisions and for hot-path decisions. */
    model: z.string().default("clef"),
    fastModel: z.string().default("clef-flash"),
    timeoutMs: z.number().int().positive().default(5_000),
  }),
]);
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type OpenAIProviderConfig = Extract<ProviderConfig, { kind: "openai" }>;
export type ClefProviderConfig = Extract<ProviderConfig, { kind: "clef" }>;

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const csv = z
  .string()
  .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean));

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  SERVICE_NAME: z.string().default("orrery"),
  DEPLOYMENT_ENV: z.string().default("dev"),

  // Postgres (pgvector)
  DATABASE_URL: z.string().default("postgres://orrery:orrery@localhost:5432/orrery"),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(20),
  DATABASE_SSL: bool.default(false),

  // Temporal
  TEMPORAL_ADDRESS: z.string().default("localhost:7233"),
  TEMPORAL_NAMESPACE: z.string().default("orrery"),
  TEMPORAL_API_KEY: z.string().optional(),
  TEMPORAL_TLS: bool.default(false),
  TEMPORAL_TLS_CERT_PATH: z.string().optional(),
  TEMPORAL_TLS_KEY_PATH: z.string().optional(),
  TEMPORAL_TASK_QUEUE_PREFIX: z.string().default("orrery"),

  // Observability
  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_SECRET_KEY: z.string().optional(),
  LANGFUSE_BASE_URL: z.string().url().optional(),
  LANGFUSE_UI_URL: z.string().url().optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  METRICS_PORT: z.coerce.number().int().positive().default(9464),

  // API / auth
  PORT: z.coerce.number().int().positive().default(8080),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:8080"),
  WEB_ORIGINS: csv.default(["http://localhost:5173"]),
  OIDC_ISSUER: z.string().url().optional(),
  OIDC_AUDIENCE: z.string().optional(),
  OIDC_TEAM_CLAIM: z.string().default("org_id"),
  OIDC_ROLE_CLAIM: z.string().default("role"),
  /** Development only: `Authorization: Bearer <DEV_AUTH_TOKEN>` acts as an owner of DEV_TEAM_ID. */
  DEV_AUTH_TOKEN: z.string().optional(),
  DEV_TEAM_ID: z.string().default("team_dev"),
  /** HMAC secret for bot-scoped MCP tokens issued to Kiro sessions (platform tools). */
  MCP_TOKEN_SECRET: z.string().min(16).default("dev-insecure-mcp-token-secret-change-me"),
  /** HMAC secret shared by workers and bot computers' ACP gateways. */
  GATEWAY_TOKEN_SECRET: z.string().min(16).default("dev-insecure-gateway-secret-change-me"),
  /** Envelope key for secrets stored in Postgres (MCP header secrets, tokens). 32 bytes base64. */
  ENCRYPTION_KEY: z.string().optional(),

  // Providers
  PROVIDERS_FILE: z.string().optional(),
  PROVIDERS_JSON: z.string().optional(),
  EMBED_PROVIDER_ID: z.string().optional(),
  FAST_PROVIDER_ID: z.string().optional(),
  CLEF_PROVIDER_ID: z.string().optional(),

  // Bot computers
  COMPUTER_PROVIDER: z.enum(["kubernetes", "local", "static"]).default("local"),
  COMPUTER_NAMESPACE: z.string().default("orrery-computers"),
  COMPUTER_IMAGE: z.string().default("ghcr.io/orrery/computer:latest"),
  COMPUTER_RUNTIME_CLASS: z.string().optional(),
  COMPUTER_STORAGE_CLASS: z.string().optional(),
  COMPUTER_KIRO_SECRET: z.string().default("orrery-kiro"),
  COMPUTER_STATIC_URL: z.string().optional(),
  KIRO_CLI_PATH: z.string().default("kiro-cli"),
  /** Used by the local computer provider to spawn an agent other than kiro-cli (tests, generic ACP). */
  LOCAL_AGENT_COMMAND: z.string().optional(),
  LOCAL_WORKSPACE_ROOT: z.string().default("/tmp/orrery-workspaces"),
});
export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached && source === process.env) return cached;
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  if (parsed.data.NODE_ENV === "production") assertProductionSafe(parsed.data);
  if (source === process.env) cached = parsed.data;
  return parsed.data;
}

/** Refuse to boot production with development secrets or the dev auth backdoor. */
export function assertProductionSafe(env: Env): void {
  const problems: string[] = [];
  if (env.DEV_AUTH_TOKEN) problems.push("DEV_AUTH_TOKEN must not be set in production");
  if (env.MCP_TOKEN_SECRET.startsWith("dev-insecure")) problems.push("MCP_TOKEN_SECRET uses the development default");
  if (env.GATEWAY_TOKEN_SECRET.startsWith("dev-insecure")) problems.push("GATEWAY_TOKEN_SECRET uses the development default");
  if (!env.OIDC_ISSUER) problems.push("OIDC_ISSUER is required in production");
  if (problems.length) throw new Error(`Unsafe production configuration: ${problems.join("; ")}`);
}

export function loadProviders(env: Pick<Env, "PROVIDERS_FILE" | "PROVIDERS_JSON">, parseYaml?: (s: string) => unknown): ProviderConfig[] {
  let raw: unknown = [];
  if (env.PROVIDERS_JSON) raw = JSON.parse(env.PROVIDERS_JSON);
  else if (env.PROVIDERS_FILE) {
    const text = readFileSync(env.PROVIDERS_FILE, "utf8");
    raw = env.PROVIDERS_FILE.endsWith(".json") || !parseYaml ? JSON.parse(text) : parseYaml(text);
  }
  const list = Array.isArray(raw) ? raw : (raw as { providers?: unknown }).providers ?? [];
  return z.array(ProviderConfigSchema).parse(list);
}

export function taskQueues(prefix: string) {
  return {
    /** Workflow tasks + short activities (DB, routing, finalize). */
    agent: `${prefix}-agent`,
    /** Long-running ACP turn activities (heartbeating, holds gateway connections). */
    acp: `${prefix}-acp`,
    /** Embeddings, extraction, consolidation, RAG ingestion. */
    memory: `${prefix}-memory`,
  } as const;
}
