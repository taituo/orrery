import type {
  ContentPart,
  InboundMessage,
  PermissionOption,
  PolicyEffect,
  ProviderBinding,
  StopReason,
  ToolKind,
  UsageSnapshot,
} from "@orrery/core/pure";

/** Workflow ids are derived from domain ids so they are idempotent and discoverable. */
export const workflowIds = {
  bot: (botId: string) => `bot:${botId}`,
  turn: (runId: string) => `turn:${runId}`,
  routineSchedule: (routineId: string) => `routine:${routineId}`,
  consolidateSchedule: (botId: string) => `memory-schedule:${botId}`,
  consolidate: (botId: string) => `memory:${botId}`,
  ingest: (sourceId: string) => `ingest:${sourceId}`,
  computerJanitor: () => `computer-janitor`,
};

export interface BotWorkflowInput {
  botId: string;
  teamId: string;
  /** State carried across continue-as-new. */
  carry?: {
    queue: InboundMessage[];
    running: Record<string, string>;
    seen: string[];
    paused: boolean;
  };
}

export interface TurnInput {
  runId: string;
  teamId: string;
  botId: string;
  threadId: string;
  /** One or more inbound messages coalesced into this turn (same thread). */
  messages: InboundMessage[];
}

export interface PreparedTurn {
  runId: string;
  teamId: string;
  botId: string;
  threadId: string;
  botName: string;
  target: "primary" | "fast";
  binding: ProviderBinding;
  /** Message id the streamed assistant reply is stored under. */
  assistantMessageId: string;
  /** User-visible input (for transcripts / tracing). */
  inputParts: ContentPart[];
  maxSteps: number;
  approvalTimeoutMinutes: number;
  replyTo: InboundMessage["replyTo"];
  authorUserId: string | null;
  /** Group conversations: hand-offs that led here (0 = a person asked). */
  hops?: number;
}

export interface AcpTurnInput {
  prepared: PreparedTurn;
  computer: { computerId: string; endpoint: string; agentKind: string; cwd: string };
}

export interface TurnOutcome {
  stopReason: StopReason | "interrupted" | "error";
  usage: UsageSnapshot;
  model: string | null;
  sessionId?: string | null;
  agentEpoch?: string | null;
  error?: { code: string; message: string } | null;
}

/* ---------------------------------------------------------------- native (OpenAI-compatible) loop */

export interface NativeToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface LlmStepInput {
  prepared: PreparedTurn;
  step: number;
  /** Conversation of this turn so far (assistant tool calls + tool results). */
  scratch: Array<{ role: "assistant" | "tool"; content: string | null; toolCalls?: NativeToolCall[]; toolCallId?: string }>;
}

export interface LlmStepResult {
  text: string;
  toolCalls: NativeToolCall[];
  finishReason: string;
  usage: UsageSnapshot;
  model: string;
}

export interface ToolEvaluation {
  toolCallId: string;
  effect: PolicyEffect;
  risk: number | null;
  reason: string;
  title: string;
  kind: ToolKind;
  capability: string;
  resource: string;
}

export interface ApprovalRequest {
  approvalId: string;
  prepared: PreparedTurn;
  toolCall: NativeToolCall;
  evaluation: ToolEvaluation;
  options: PermissionOption[];
}

export interface ApprovalDecisionSignal {
  approvalId: string;
  optionId: string | null;
  optionKind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | null;
  cancelled: boolean;
  actor: string;
}

export interface FinalizeInput {
  prepared: PreparedTurn;
  outcome: TurnOutcome;
  status: "completed" | "failed" | "cancelled" | "interrupted";
}

export interface FinalizeResult {
  episodeId: string | null;
  needsConsolidation: boolean;
}

export interface BotState {
  botId: string;
  paused: boolean;
  queued: number;
  running: Record<string, string>;
}
