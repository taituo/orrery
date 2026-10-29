import type {
  AgentEvent,
  Approval,
  Bot,
  BotCreate,
  ContentPart,
  KnowledgeBase,
  KnowledgeSource,
  MemoryItem,
  MemoryKind,
  Message,
  PermissionOptionKind,
  Routine,
  Run,
  RunEventEnvelope,
  Thread,
} from "@orrery/core/pure";

export type {
  AgentEvent,
  Approval,
  Bot,
  BotCreate,
  ContentPart,
  KnowledgeBase,
  KnowledgeSource,
  MemoryItem,
  MemoryKind,
  Message,
  PermissionOptionKind,
  Routine,
  Run,
  RunEventEnvelope,
  Thread,
};

export interface Principal {
  userId: string;
  teamId: string;
  role: "owner" | "admin" | "member" | "viewer";
  name: string | null;
  email: string | null;
}

export interface BotState {
  botId: string;
  paused: boolean;
  queued: number;
  running: Record<string, string>; // threadId → runId
}

export interface ProviderInfo {
  id: string;
  kind: "openai" | "clef" | string;
  roles: string[];
  /** openai: { chat: string[]; embed?: string; rerank?: string }; clef: { model; fastModel } */
  models: Record<string, unknown>;
}

export interface UsageRow {
  botId: string;
  provider: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  credits: number;
  costUsd: number;
}

export interface ComputerRow {
  id: string;
  teamId: string;
  botId: string | null;
  provider: string;
  status: "provisioning" | "ready" | "stopped" | "failed" | string;
  endpoint: string | null;
  agentKind: string;
  lastActiveAt: string | null;
}

export interface AuditEntry {
  id?: number | string;
  actor: string;
  action: string;
  target: string | null;
  data: Record<string, unknown>;
  at?: string;
  created_at?: string;
}

export interface RecallResult {
  id: string;
  kind: string;
  content: string;
  score: number;
}

export interface KnowledgeHit {
  chunkId: string;
  sourceId: string;
  sourceTitle: string;
  uri: string;
  heading: string | null;
  content: string;
  score: number;
}

export interface WriteOutcome {
  action: "created" | "updated" | "superseded" | "skipped";
  reason: string;
  id?: string;
  content: string;
}

export type TeamNotice = { kind: "run_event"; runId: string; threadId: string; seq: number } | { kind: "approval"; id: string };

export interface SendResult {
  messageId: string;
  threadId: string;
  mode: "queue" | "steer";
  runId?: string;
}

/** Everything the console needs. Implemented over HTTP and by the in-browser mock. */
export interface OrreryApi {
  readonly mode: "live" | "mock";
  me(): Promise<Principal>;

  listBots(): Promise<Bot[]>;
  getBot(id: string): Promise<{ bot: Bot; state: BotState | null }>;
  createBot(input: BotCreate): Promise<Bot>;
  updateBot(id: string, patch: Partial<BotCreate> & { status?: Bot["status"] }): Promise<Bot>;
  archiveBot(id: string): Promise<void>;

  listThreads(botId: string): Promise<Thread[]>;
  createThread(botId: string, title?: string): Promise<Thread>;
  archiveThread(threadId: string): Promise<void>;
  listMessages(threadId: string): Promise<Message[]>;
  sendMessage(threadId: string, body: { text: string; mode: "queue" | "steer" }): Promise<SendResult>;

  listRuns(threadId: string): Promise<Run[]>;
  activeRuns(): Promise<Run[]>;
  getRun(runId: string): Promise<{ run: Run; traceUrl: string | null }>;
  runEvents(runId: string): Promise<RunEventEnvelope[]>;
  cancelRun(runId: string): Promise<void>;
  feedback(runId: string, value: number, comment?: string): Promise<void>;
  /** Live events of a thread (with backlog). Returns an unsubscribe function. */
  streamThread(threadId: string, onEvent: (e: RunEventEnvelope) => void, onState?: (s: "connecting" | "open" | "retrying") => void): () => void;
  streamTeam(onNotice: (n: TeamNotice) => void): () => void;

  listApprovals(botId?: string): Promise<Approval[]>;
  decideApproval(id: string, d: { optionId?: string; cancel?: boolean; persist?: { scope: "workspace" | "user" | "bot"; resource: string }; note?: string }): Promise<Approval>;

  coreMemory(botId: string): Promise<Record<"persona" | "human" | "notes", string>>;
  setCoreMemory(botId: string, block: "persona" | "human" | "notes", content: string): Promise<void>;
  listMemories(q: { botId?: string; kind?: MemoryKind; q?: string; includeSuperseded?: boolean }): Promise<MemoryItem[]>;
  writeMemory(botId: string, m: { kind: MemoryKind; content: string; importance?: number; pinned?: boolean }): Promise<WriteOutcome>;
  updateMemory(id: string, patch: Partial<Pick<MemoryItem, "content" | "importance" | "pinned" | "kind" | "tags">>): Promise<MemoryItem>;
  forgetMemory(id: string): Promise<void>;
  recall(botId: string, query: string): Promise<RecallResult[]>;
  consolidate(botId: string): Promise<void>;

  listKnowledgeBases(): Promise<KnowledgeBase[]>;
  createKnowledgeBase(k: { name: string; description: string }): Promise<KnowledgeBase>;
  listSources(kbId: string): Promise<KnowledgeSource[]>;
  addSource(kbId: string, s: { type: "url"; uri: string; title?: string } | { type: "text"; title: string; text: string } | { type: "upload"; file: File }): Promise<KnowledgeSource>;
  deleteSource(id: string): Promise<void>;
  reingest(id: string): Promise<void>;
  searchKnowledge(kbIds: string[], query: string): Promise<{ hits: KnowledgeHit[]; sufficient: boolean | null }>;

  listRoutines(botId?: string): Promise<Routine[]>;
  createRoutine(r: { botId: string; name: string; prompt: string; schedule: { cron?: string; intervalMinutes?: number; timezone: string }; threadPolicy: "new" | "reuse"; enabled: boolean }): Promise<Routine>;
  updateRoutine(id: string, patch: Partial<Pick<Routine, "name" | "prompt" | "schedule" | "enabled" | "threadPolicy">>): Promise<Routine>;
  deleteRoutine(id: string): Promise<void>;
  runRoutine(id: string): Promise<void>;

  providers(): Promise<{ providers: ProviderInfo[]; decisions: string | null }>;
  testProvider(id: string): Promise<{ ok: boolean; latencyMs: number }>;
  usage(days: number): Promise<UsageRow[]>;
  computers(): Promise<ComputerRow[]>;
  audit(): Promise<AuditEntry[]>;
  listSecrets(): Promise<Array<{ name: string; createdAt: string }>>;
  putSecret(name: string, value: string): Promise<void>;
  deleteSecret(name: string): Promise<void>;
  webhookToken(botId: string): Promise<{ token: string; url: string }>;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}
