import type { InboundMessage } from "@orrery/core/pure";
import type {
  AcpTurnInput,
  ApprovalRequest,
  FinalizeInput,
  FinalizeResult,
  LlmStepInput,
  LlmStepResult,
  NativeToolCall,
  PreparedTurn,
  ToolEvaluation,
  TurnInput,
  TurnOutcome,
} from "./types.js";

/**
 * Activity contracts. Implemented in apps/worker; workflows only see these signatures, which
 * keeps workflow code deterministic and free of I/O imports.
 */

/** Task queue `<prefix>-agent`: short, idempotent DB/provider work. */
export interface AgentActivities {
  prepareTurn(input: TurnInput): Promise<PreparedTurn>;
  ensureComputer(input: { teamId: string; botId: string }): Promise<{ computerId: string; endpoint: string; agentKind: string; cwd: string }>;
  llmStep(input: LlmStepInput): Promise<LlmStepResult>;
  evaluateToolCall(input: { prepared: PreparedTurn; toolCall: NativeToolCall }): Promise<ToolEvaluation>;
  openApproval(input: ApprovalRequest): Promise<{ expiresAt: string }>;
  closeApproval(input: { prepared: PreparedTurn; approvalId: string; outcome: "selected" | "cancelled" | "expired"; optionKind: string | null; actor: string; decidedBy: "user" | "timeout" | "system" }): Promise<void>;
  executeTool(input: { prepared: PreparedTurn; toolCall: NativeToolCall }): Promise<{ ok: boolean; output: string }>;
  recordToolDenied(input: { prepared: PreparedTurn; toolCall: NativeToolCall; reason: string }): Promise<void>;
  finalizeTurn(input: FinalizeInput): Promise<FinalizeResult>;
  /** Signal-with-start the bot entity workflow (used by routines and delegation replies). */
  deliverInbound(input: { message: InboundMessage }): Promise<void>;
  prepareRoutineRun(input: { routineId: string }): Promise<InboundMessage | null>;
  reapIdleComputers(): Promise<{ stopped: number }>;
}

/** Task queue `<prefix>-acp`: long-running, heartbeating ACP turns through bot computers. */
export interface AcpActivities {
  runAcpTurn(input: AcpTurnInput): Promise<TurnOutcome>;
}

/** Task queue `<prefix>-memory`: embeddings, extraction, consolidation, ingestion. */
export interface MemoryActivities {
  consolidateMemories(input: { teamId: string; botId: string }): Promise<{ episodes: number; created: number; updated: number; superseded: number; skipped: number; decayed: number }>;
  ingestSource(input: { sourceId: string }): Promise<{ chunks: number; rejected: number; skipped: boolean }>;
}
