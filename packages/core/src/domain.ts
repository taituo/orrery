import { z } from "zod";
import type { ContentPart } from "./content.js";
import type { ConsentContext, McpAnnotations, PermissionOption, StopReason, ToolKind, UsageSnapshot } from "./events.js";

/* ------------------------------------------------------------------------------------------ */
/* Provider bindings                                                                           */
/* ------------------------------------------------------------------------------------------ */

/** Kiro over ACP. `engine` selects the CLI V3 adapter, the legacy CLI v2 adapter, or auto. */
export const KiroBindingSchema = z.object({
  kind: z.literal("kiro-acp"),
  engine: z.enum(["v3", "v2", "auto"]).default("v3"),
  /** V3: advertised mode id (e.g. "vibe", "planner"); v2: custom agent name passed with --agent. */
  modeId: z.string().min(1).optional(),
  /** Advertised model id ("auto", "claude-sonnet", ...). Validated against the server's advertisement. */
  modelId: z.string().min(1).optional(),
  /** V3 `effortLevel` config option / v2 `/effort`. */
  effort: z.string().min(1).optional(),
  /** Who answers `_kiro/auth/getAccessToken` (V3 only). */
  authMethod: z.enum(["cli", "client"]).default("cli"),
});

/**
 * OpenCode (`opencode acp`). Models are "provider/model" ids from OpenCode's catalog (credentials
 * via env on the bot computer, e.g. ANTHROPIC_API_KEY) or from Orrery's own OpenAI-compatible
 * providers, which are exposed to OpenCode as `orrery-<providerId>/<model>`.
 */
export const OpenCodeBindingSchema = z.object({
  kind: z.literal("opencode-acp"),
  /** OpenCode agent (ACP session mode): "build", "plan", or a custom agent from the config. */
  modeId: z.string().min(1).optional(),
  /** "provider/model", e.g. "anthropic/claude-sonnet-4-5" or "orrery-local-vllm/qwen3-235b-a22b". */
  modelId: z.string().min(1).optional(),
  /** Model for titles/summaries inside OpenCode ("provider/model"). */
  smallModelId: z.string().min(1).optional(),
  /**
   * orrery: every tool call is asked over ACP and decided by the bot's Orrery policy (default).
   * agent: OpenCode's own permission rules apply; Orrery only sees what OpenCode asks about.
   */
  permissions: z.enum(["orrery", "agent"]).default("orrery"),
  /** Extra opencode.json settings merged into the generated config (agents, formatters, LSP, …). */
  config: z.record(z.string(), z.unknown()).optional(),
});

/** Any other ACP agent (Gemini CLI, Claude Code ACP adapter, Codex ACP, ...). */
export const GenericAcpBindingSchema = z.object({
  kind: z.literal("acp"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  modeId: z.string().optional(),
  modelId: z.string().optional(),
});

/** OpenAI-compatible chat model driven by Orrery's own durable tool loop. */
export const OpenAIBindingSchema = z.object({
  kind: z.literal("openai"),
  providerId: z.string().min(1),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxSteps: z.number().int().min(1).max(64).default(12),
});

export const ProviderBindingSchema = z.discriminatedUnion("kind", [KiroBindingSchema, OpenCodeBindingSchema, GenericAcpBindingSchema, OpenAIBindingSchema]);
export type ProviderBinding = z.infer<typeof ProviderBindingSchema>;
export type KiroBinding = z.infer<typeof KiroBindingSchema>;
export type OpenCodeBinding = z.infer<typeof OpenCodeBindingSchema>;
export type OpenAIBinding = z.infer<typeof OpenAIBindingSchema>;
export type GenericAcpBinding = z.infer<typeof GenericAcpBindingSchema>;

/* ------------------------------------------------------------------------------------------ */
/* Tool policy                                                                                 */
/* ------------------------------------------------------------------------------------------ */

export const PolicyEffectSchema = z.enum(["allow", "ask", "deny"]);
export type PolicyEffect = z.infer<typeof PolicyEffectSchema>;

export const PolicyRuleSchema = z.object({
  id: z.string().min(1),
  effect: PolicyEffectSchema,
  /** Capability / tool kind: shell, read, write, edit, delete, move, fetch, search, mcp, platform, think, other, * */
  capability: z.string().default("*"),
  /** Glob over the resource (command line, path, URL, tool name). `*` and `**` supported. */
  resource: z.string().default("**"),
  mcpServer: z.string().optional(),
  tool: z.string().optional(),
  reason: z.string().optional(),
});
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

export const ToolPolicySchema = z.object({
  defaultEffect: PolicyEffectSchema.default("ask"),
  rules: z.array(PolicyRuleSchema).default([]),
  guardrail: z
    .object({
      enabled: z.boolean().default(true),
      /** Escalate allow → ask when the Clef risk probability is above this. */
      askAbove: z.number().min(0).max(1).default(0.5),
      /** Escalate to deny when above this. */
      denyAbove: z.number().min(0).max(1).default(0.92),
    })
    .default({ enabled: true, askAbove: 0.5, denyAbove: 0.92 }),
  approvalTimeoutMinutes: z.number().int().min(1).max(60 * 24 * 7).default(60 * 24),
  /** Let humans grant persistent consent (Kiro V3 `allow_always` + `_meta.kiro.consent`). */
  allowPersistentConsent: z.boolean().default(true),
});
export type ToolPolicy = z.infer<typeof ToolPolicySchema>;

/* ------------------------------------------------------------------------------------------ */
/* MCP servers attached to a bot                                                               */
/* ------------------------------------------------------------------------------------------ */

export const McpServerConfigSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("http"),
    name: z.string().min(1),
    url: z.string().url(),
    headers: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
    /** Header values may reference secrets: `secret://<name>`; resolved in the worker only. */
  }),
  z.object({
    type: z.literal("sse"),
    name: z.string().min(1),
    url: z.string().url(),
    headers: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
  }),
  z.object({
    type: z.literal("stdio"),
    name: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
  }),
]);
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

/* ------------------------------------------------------------------------------------------ */
/* Bot                                                                                         */
/* ------------------------------------------------------------------------------------------ */

export const ComputerSpecSchema = z.object({
  enabled: z.boolean().default(true),
  image: z.string().optional(),
  size: z.enum(["small", "medium", "large"]).default("small"),
  idleMinutes: z.number().int().min(5).max(60 * 24 * 7).default(60),
  persistentHome: z.boolean().default(true),
  /** Shared team computer (one pod for several bots) or private. */
  shared: z.boolean().default(false),
  network: z
    .object({
      mode: z.enum(["restricted", "open", "none"]).default("restricted"),
      allow: z.array(z.string()).default([]),
    })
    .default({ mode: "restricted", allow: [] }),
});
export type ComputerSpec = z.infer<typeof ComputerSpecSchema>;

export const MemorySettingsSchema = z.object({
  enabled: z.boolean().default(true),
  autoExtract: z.boolean().default(true),
  recallK: z.number().int().min(0).max(50).default(8),
  /** Memories visible to this bot: only its own, or the whole team's shared pool too. */
  shareScope: z.enum(["bot", "team"]).default("bot"),
  coreMemoryCharLimit: z.number().int().min(200).max(20000).default(4000),
});
export type MemorySettings = z.infer<typeof MemorySettingsSchema>;

export const RoutingSettingsSchema = z.object({
  /** fixed: always the primary binding. auto: Clef decides per message between fast and primary. */
  mode: z.enum(["fixed", "auto"]).default("fixed"),
  fast: OpenAIBindingSchema.optional(),
  /** Probability the message needs the agent (tools/computer) below which the fast model answers. */
  agentThreshold: z.number().min(0).max(1).default(0.35),
});
export type RoutingSettings = z.infer<typeof RoutingSettingsSchema>;

export const BotSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  name: z.string().min(1).max(80),
  avatar: z.string().max(16).optional(),
  description: z.string().max(500).default(""),
  /** Persona / standing instructions. Sent as system prompt where supported, else as a preamble. */
  instructions: z.string().max(20000).default(""),
  primary: ProviderBindingSchema,
  routing: RoutingSettingsSchema.default({ mode: "fixed", agentThreshold: 0.35 }),
  policy: ToolPolicySchema,
  computer: ComputerSpecSchema,
  memory: MemorySettingsSchema,
  knowledgeBaseIds: z.array(z.string()).default([]),
  mcpServers: z.array(McpServerConfigSchema).default([]),
  /** Bots this bot may delegate to. */
  peers: z.array(z.string()).default([]),
  status: z.enum(["active", "paused", "archived"]).default("active"),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Bot = z.infer<typeof BotSchema>;

export const BotCreateSchema = BotSchema.omit({ id: true, teamId: true, createdAt: true, updatedAt: true, status: true }).extend({
  policy: ToolPolicySchema.default({
    defaultEffect: "ask",
    rules: [],
    guardrail: { enabled: true, askAbove: 0.5, denyAbove: 0.92 },
    approvalTimeoutMinutes: 1440,
    allowPersistentConsent: true,
  }),
  computer: ComputerSpecSchema.default({
    enabled: true,
    size: "small",
    idleMinutes: 60,
    persistentHome: true,
    shared: false,
    network: { mode: "restricted", allow: [] },
  }),
  memory: MemorySettingsSchema.default({ enabled: true, autoExtract: true, recallK: 8, shareScope: "bot", coreMemoryCharLimit: 4000 }),
});
export type BotCreate = z.input<typeof BotCreateSchema>;

export const BotPatchSchema = BotCreateSchema.partial().extend({ status: z.enum(["active", "paused", "archived"]).optional() });

/* ------------------------------------------------------------------------------------------ */
/* Conversation                                                                                */
/* ------------------------------------------------------------------------------------------ */

export type Channel = "web" | "api" | "slack" | "routine" | "peer" | "webhook" | "group";

/** A group conversation: 1–6 bots (the lead answers unless others are @mentioned) and people. */
export interface Group {
  id: string;
  teamId: string;
  name: string;
  topic: string;
  threadId: string;
  members: Array<{ botId: string; name: string; lead: boolean; avatar?: string | null }>;
  createdBy: string;
  createdAt: string;
}

/** Most hand-offs (a bot mentioning another bot) one message can trigger in a group. */
export const GROUP_MAX_HOPS = 6;

export interface Thread {
  id: string;
  teamId: string;
  botId: string;
  title: string;
  channel: Channel;
  /** ACP session id bound to this thread (per bot computer), if any. */
  acpSessionId?: string | null;
  createdBy: string;
  archived: boolean;
  lastActivityAt: string;
  createdAt: string;
}

export type MessageRole = "user" | "assistant" | "system" | "peer";

export interface Message {
  id: string;
  threadId: string;
  role: MessageRole;
  author: { type: "user" | "bot" | "system"; id: string; name?: string };
  parts: ContentPart[];
  runId?: string | null;
  createdAt: string;
  meta?: Record<string, unknown>;
}

export type RunStatus = "queued" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled" | "interrupted";

export interface Run {
  id: string;
  teamId: string;
  botId: string;
  threadId: string;
  triggerMessageId: string | null;
  status: RunStatus;
  provider: string;
  model: string | null;
  engine: string | null;
  stopReason: StopReason | null;
  usage: UsageSnapshot;
  error: { code: string; message: string } | null;
  workflowId: string;
  traceId: string | null;
  startedAt: string;
  endedAt: string | null;
}

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";

export interface Approval {
  id: string;
  teamId: string;
  botId: string;
  threadId: string;
  runId: string;
  toolCallId: string;
  title: string;
  kind: ToolKind;
  capability: string;
  resource: string;
  rawInput: unknown;
  options: PermissionOption[];
  consent: ConsentContext | null;
  mcpTool: { server?: string; tool?: string; annotations?: McpAnnotations } | null;
  risk: number | null;
  status: ApprovalStatus;
  decision: {
    optionId: string | null;
    optionKind: string | null;
    persist?: { scope: "workspace" | "user" | "bot"; resource: string } | null;
    by: string;
    at: string;
    note?: string | null;
  } | null;
  createdAt: string;
  expiresAt: string;
}

export const ApprovalDecisionSchema = z.object({
  /** Must be one of the optionIds the agent supplied. Never synthesized. */
  optionId: z.string().min(1).optional(),
  /** Convenience: pick the first offered option of this kind. */
  optionKind: z.enum(["allow_once", "allow_always", "reject_once", "reject_always"]).optional(),
  cancel: z.boolean().optional(),
  persist: z
    .object({ scope: z.enum(["workspace", "user", "bot"]).default("workspace"), resource: z.string().min(1) })
    .optional(),
  note: z.string().max(2000).optional(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

/* ------------------------------------------------------------------------------------------ */
/* Memory                                                                                      */
/* ------------------------------------------------------------------------------------------ */

export const MemoryKindSchema = z.enum(["fact", "preference", "instruction", "entity", "procedure", "episode_summary"]);
export type MemoryKind = z.infer<typeof MemoryKindSchema>;
export type MemoryScope = "bot" | "team" | "user";

export interface MemoryItem {
  id: string;
  teamId: string;
  botId: string | null;
  userId: string | null;
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  tags: string[];
  importance: number;
  confidence: number;
  pinned: boolean;
  source: { type: "turn" | "user" | "import" | "consolidation" | "tool"; runId?: string; messageId?: string; threadId?: string };
  validFrom: string;
  validTo: string | null;
  supersededBy: string | null;
  accessCount: number;
  lastAccessedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const MemoryWriteSchema = z.object({
  kind: MemoryKindSchema,
  content: z.string().min(1).max(4000),
  tags: z.array(z.string().max(64)).max(16).default([]),
  importance: z.number().min(0).max(1).default(0.5),
  scope: z.enum(["bot", "team", "user"]).default("bot"),
  pinned: z.boolean().default(false),
});

export type CoreMemoryBlock = "persona" | "human" | "notes";

/* ------------------------------------------------------------------------------------------ */
/* Knowledge (RAG)                                                                             */
/* ------------------------------------------------------------------------------------------ */

export interface KnowledgeBase {
  id: string;
  teamId: string;
  name: string;
  description: string;
  embeddingModel: string;
  embeddingDims: number;
  chunkSize: number;
  chunkOverlap: number;
  createdAt: string;
}

export type SourceStatus = "pending" | "ingesting" | "ready" | "failed";

export interface KnowledgeSource {
  id: string;
  knowledgeBaseId: string;
  type: "upload" | "url" | "text";
  uri: string;
  title: string;
  mimeType: string | null;
  status: SourceStatus;
  error: string | null;
  stats: { chunks?: number; rejected?: number; bytes?: number; tokens?: number };
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------------------------------ */
/* Routines                                                                                    */
/* ------------------------------------------------------------------------------------------ */

export const RoutineScheduleSchema = z
  .object({
    cron: z.string().min(9).optional(),
    intervalMinutes: z.number().int().min(1).max(60 * 24 * 30).optional(),
    timezone: z.string().default("UTC"),
  })
  .refine((s) => Boolean(s.cron) !== Boolean(s.intervalMinutes), { message: "Provide exactly one of cron or intervalMinutes" });

export const RoutineCreateSchema = z.object({
  botId: z.string(),
  name: z.string().min(1).max(120),
  prompt: z.string().min(1).max(20000),
  schedule: RoutineScheduleSchema,
  threadPolicy: z.enum(["new", "reuse"]).default("reuse"),
  enabled: z.boolean().default(true),
});

export interface Routine {
  id: string;
  teamId: string;
  botId: string;
  name: string;
  prompt: string;
  schedule: z.infer<typeof RoutineScheduleSchema>;
  threadPolicy: "new" | "reuse";
  threadId: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  createdAt: string;
}

/* ------------------------------------------------------------------------------------------ */
/* Inbound work for a bot (what the bot entity workflow consumes)                              */
/* ------------------------------------------------------------------------------------------ */

export interface InboundMessage {
  /** Idempotency key: the persisted message id. */
  messageId: string;
  threadId: string;
  botId: string;
  teamId: string;
  channel: Channel;
  author: { type: "user" | "bot" | "system"; id: string; name?: string };
  parts: ContentPart[];
  /** Set when a peer bot delegated work and wants the result back. */
  replyTo?: { botId: string; threadId: string; delegationId: string } | null;
  /** Override the provider for this turn (e.g. a routine pinned to the fast model). */
  forceProvider?: "primary" | "fast" | null;
  /** Group conversations: how many bot hand-offs led to this message (0 = from a person). */
  hops?: number;
  receivedAt: string;
}
