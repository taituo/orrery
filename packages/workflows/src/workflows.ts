import {
  ApplicationFailure,
  CancellationScope,
  ParentClosePolicy,
  WorkflowIdReusePolicy,
  ActivityCancellationType,
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  getExternalWorkflowHandle,
  isCancellation,
  log,
  proxyActivities,
  setHandler,
  startChild,
  uuid4,
  workflowInfo,
} from "@temporalio/workflow";
import type { InboundMessage, PermissionOption } from "@orrery/core/pure";
import type { AcpActivities, AgentActivities, MemoryActivities } from "./activities.js";
import { enqueue, hasRunnable, makeRunId, takeRunnable, type SchedulerState } from "./scheduler.js";
import {
  workflowIds,
  type ApprovalDecisionSignal,
  type BotState,
  type BotWorkflowInput,
  type LlmStepInput,
  type PreparedTurn,
  type TurnInput,
  type TurnOutcome,
} from "./types.js";

/* ============================================================================ signals / queries */

export const inboundSignal = defineSignal<[InboundMessage]>("inbound");
export const turnFinishedSignal = defineSignal<[{ threadId: string; runId: string }]>("turnFinished");
export const setPausedSignal = defineSignal<[boolean]>("setPaused");
export const cancelThreadSignal = defineSignal<[{ threadId: string }]>("cancelThread");
export const botStateQuery = defineQuery<BotState>("state");

export const approvalDecisionSignal = defineSignal<[ApprovalDecisionSignal]>("approvalDecision");
export const turnProgressQuery = defineQuery<{ phase: string; step: number; pendingApprovals: string[] }>("progress");

/* ============================================================================ activity proxies */

/** Each workflow gets its task queue names through memo-free conventions: `${prefix}-agent` etc. */
function queues() {
  const prefix = (workflowInfo().taskQueue.match(/^(.*)-(agent|acp|memory)$/)?.[1]) ?? "orrery";
  return { agent: `${prefix}-agent`, acp: `${prefix}-acp`, memory: `${prefix}-memory` };
}

function agentActs() {
  return proxyActivities<AgentActivities>({
    taskQueue: queues().agent,
    startToCloseTimeout: "2 minutes",
    retry: { initialInterval: "1s", backoffCoefficient: 2, maximumInterval: "30s", maximumAttempts: 8, nonRetryableErrorTypes: ["bad_request", "not_found", "forbidden", "policy_denied"] },
  });
}

function llmActs() {
  return proxyActivities<Pick<AgentActivities, "llmStep" | "executeTool">>({
    taskQueue: queues().agent,
    startToCloseTimeout: "10 minutes",
    heartbeatTimeout: "60 seconds",
    retry: { initialInterval: "2s", backoffCoefficient: 2, maximumInterval: "1 minute", maximumAttempts: 5, nonRetryableErrorTypes: ["bad_request", "not_found", "forbidden"] },
  });
}

function acpActs() {
  return proxyActivities<AcpActivities>({
    taskQueue: queues().acp,
    // A turn may wait hours for a human approval; liveness comes from heartbeats.
    startToCloseTimeout: "24 hours",
    heartbeatTimeout: "45 seconds",
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    retry: {
      initialInterval: "2s",
      backoffCoefficient: 2,
      maximumInterval: "1 minute",
      maximumAttempts: 6,
      // never retry semantic failures; a retry after a worker crash resumes (never re-prompts)
      nonRetryableErrorTypes: ["bad_request", "not_found", "forbidden", "provider_error", "interrupted", "capability_unsupported"],
    },
  });
}

function memoryActs() {
  return proxyActivities<MemoryActivities>({
    taskQueue: queues().memory,
    startToCloseTimeout: "30 minutes",
    heartbeatTimeout: "2 minutes",
    retry: { initialInterval: "5s", backoffCoefficient: 2, maximumInterval: "5 minutes", maximumAttempts: 10 },
  });
}

/* ============================================================================ bot entity workflow */

const MAX_CONCURRENT_THREADS = 4;

/**
 * One long-lived workflow per bot ("standing agent"). It serializes turns per thread, runs
 * threads concurrently, coalesces messages that arrive mid-turn, survives restarts and
 * continues-as-new to keep history bounded. Turns run as child workflows with ABANDON so they
 * outlive continue-as-new; they report back with `turnFinished`.
 */
export async function botWorkflow(input: BotWorkflowInput): Promise<void> {
  const state: SchedulerState = {
    queue: input.carry?.queue ?? [],
    running: input.carry?.running ?? {},
    seen: input.carry?.seen ?? [],
    paused: input.carry?.paused ?? false,
  };

  setHandler(inboundSignal, (msg) => {
    if (enqueue(state, msg)) log.info("inbound queued", { threadId: msg.threadId, messageId: msg.messageId });
  });
  setHandler(turnFinishedSignal, ({ threadId, runId }) => {
    if (state.running[threadId] === runId) delete state.running[threadId];
  });
  setHandler(setPausedSignal, (paused) => {
    state.paused = paused;
  });
  setHandler(cancelThreadSignal, ({ threadId }) => {
    const runId = state.running[threadId];
    if (runId) void getExternalWorkflowHandle(workflowIds.turn(runId)).cancel();
    state.queue = state.queue.filter((m) => m.threadId !== threadId);
  });
  setHandler(botStateQuery, () => ({ botId: input.botId, paused: state.paused, queued: state.queue.length, running: { ...state.running } }));

  for (;;) {
    await condition(() => hasRunnable(state, MAX_CONCURRENT_THREADS) || workflowInfo().continueAsNewSuggested || workflowInfo().historyLength > 8000);

    for (const batch of takeRunnable(state, MAX_CONCURRENT_THREADS)) {
      const runId = makeRunId(Date.now(), uuid4());
      state.running[batch.threadId] = runId;
      const turn: TurnInput = { runId, teamId: input.teamId, botId: input.botId, threadId: batch.threadId, messages: batch.messages };
      try {
        await startChild(turnWorkflow, {
          workflowId: workflowIds.turn(runId),
          args: [turn],
          taskQueue: queues().agent,
          parentClosePolicy: ParentClosePolicy.ABANDON,
          workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
          memo: { botId: input.botId, threadId: batch.threadId },
        });
      } catch (err) {
        log.error("failed to start turn", { runId, error: String(err) });
        delete state.running[batch.threadId];
        state.queue.unshift(...batch.messages);
      }
    }

    if ((workflowInfo().continueAsNewSuggested || workflowInfo().historyLength > 8000) && !hasRunnable(state, MAX_CONCURRENT_THREADS)) {
      await continueAsNew<typeof botWorkflow>({ botId: input.botId, teamId: input.teamId, carry: { ...state } });
    }
  }
}

/* ============================================================================ one agent turn */

export async function turnWorkflow(input: TurnInput): Promise<TurnOutcome> {
  const agent = agentActs();
  const decisions = new Map<string, ApprovalDecisionSignal>();
  const progress = { phase: "preparing", step: 0, pendingApprovals: [] as string[] };
  setHandler(approvalDecisionSignal, (d) => {
    decisions.set(d.approvalId, d);
  });
  setHandler(turnProgressQuery, () => ({ ...progress, pendingApprovals: [...progress.pendingApprovals] }));

  let prepared: PreparedTurn | null = null;
  let outcome: TurnOutcome = { stopReason: "error", usage: {}, model: null };
  let status: "completed" | "failed" | "cancelled" | "interrupted" = "failed";
  try {
    prepared = await agent.prepareTurn(input);
    progress.phase = "running";
    if (prepared.binding.kind === "openai") {
      outcome = await nativeLoop(prepared, decisions, progress);
    } else {
      const computer = await agent.ensureComputer({ teamId: input.teamId, botId: input.botId });
      outcome = await acpActs().runAcpTurn({ prepared, computer });
    }
    status = outcome.stopReason === "cancelled" ? "cancelled" : outcome.stopReason === "interrupted" ? "interrupted" : outcome.stopReason === "error" ? "failed" : "completed";
  } catch (err) {
    if (isCancellation(err)) {
      status = "cancelled";
      outcome = { ...outcome, stopReason: "cancelled" };
    } else {
      status = errorType(err) === "interrupted" ? "interrupted" : "failed";
      outcome = { ...outcome, stopReason: status === "interrupted" ? "interrupted" : "error", error: { code: errorType(err) ?? "internal", message: errorMessage(err) } };
    }
  } finally {
    progress.phase = "finalizing";
    await CancellationScope.nonCancellable(async () => {
      if (prepared) {
        try {
          const fin = await agent.finalizeTurn({ prepared, outcome, status });
          if (fin.needsConsolidation) await startConsolidation(input.teamId, input.botId);
        } catch (err) {
          log.error("finalize failed", { runId: input.runId, error: String(err) });
        }
      }
      try {
        await getExternalWorkflowHandle(workflowIds.bot(input.botId)).signal(turnFinishedSignal, { threadId: input.threadId, runId: input.runId });
      } catch {
        /* bot workflow may be terminated; nothing to do */
      }
    });
  }
  if (status === "failed") throw ApplicationFailure.create({ type: outcome.error?.code ?? "internal", message: outcome.error?.message ?? "turn failed", nonRetryable: true });
  return outcome;
}

async function startConsolidation(teamId: string, botId: string): Promise<void> {
  try {
    await startChild(consolidateMemoryWorkflow, {
      workflowId: workflowIds.consolidate(botId),
      args: [{ teamId, botId }],
      taskQueue: queues().agent,
      parentClosePolicy: ParentClosePolicy.ABANDON,
      workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
    });
  } catch {
    /* already running: it will pick up the new episode */
  }
}

/** Orrery's own durable tool loop for OpenAI-compatible models: every step and decision is history. */
async function nativeLoop(prepared: PreparedTurn, decisions: Map<string, ApprovalDecisionSignal>, progress: { phase: string; step: number; pendingApprovals: string[] }): Promise<TurnOutcome> {
  const agent = agentActs();
  const llm = llmActs();
  const scratch: LlmStepInput["scratch"] = [];
  const usage: TurnOutcome["usage"] = {};
  let model: string | null = null;
  for (let step = 0; step < prepared.maxSteps; step++) {
    progress.step = step;
    const r = await llm.llmStep({ prepared, step, scratch });
    model = r.model;
    accumulate(usage, r.usage);
    if (!r.toolCalls.length) return { stopReason: r.finishReason === "length" ? "max_tokens" : "end_turn", usage, model };
    scratch.push({ role: "assistant", content: r.text || null, toolCalls: r.toolCalls });
    for (const call of r.toolCalls) {
      const ev = await agent.evaluateToolCall({ prepared, toolCall: call });
      let allowed = ev.effect === "allow";
      let reason = ev.reason;
      if (ev.effect === "ask") {
        const approvalId = `apr_${call.id}_${prepared.runId}`.slice(0, 120);
        const options: PermissionOption[] = [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Deny", kind: "reject_once" },
        ];
        await agent.openApproval({ approvalId, prepared, toolCall: call, evaluation: ev, options });
        progress.pendingApprovals.push(approvalId);
        const got = await condition(() => decisions.has(approvalId), `${prepared.approvalTimeoutMinutes} minutes`);
        progress.pendingApprovals = progress.pendingApprovals.filter((x) => x !== approvalId);
        const d = decisions.get(approvalId);
        allowed = Boolean(got && d && !d.cancelled && (d.optionKind === "allow_once" || d.optionKind === "allow_always"));
        reason = !got ? "approval timed out" : allowed ? "approved by human" : "denied by human";
        await agent.closeApproval({ prepared, approvalId, outcome: !got ? "expired" : d?.cancelled ? "cancelled" : "selected", optionKind: d?.optionKind ?? null, actor: d?.actor ?? "system", decidedBy: got ? "user" : "timeout" });
      }
      if (allowed) {
        const res = await llm.executeTool({ prepared, toolCall: call });
        scratch.push({ role: "tool", toolCallId: call.id, content: res.output.slice(0, 16_000) });
      } else {
        await agent.recordToolDenied({ prepared, toolCall: call, reason });
        scratch.push({ role: "tool", toolCallId: call.id, content: `Tool call was not executed: ${reason}. Continue without it or ask the user.` });
      }
    }
  }
  return { stopReason: "max_turn_requests", usage, model };
}

function accumulate(into: TurnOutcome["usage"], u: TurnOutcome["usage"]): void {
  for (const k of ["inputTokens", "outputTokens", "totalTokens", "thoughtTokens", "cachedReadTokens"] as const) {
    if (typeof u[k] === "number") into[k] = (into[k] ?? 0) + u[k]!;
  }
}

function errorType(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur; i++) {
    const t = (cur as { type?: string }).type;
    if (typeof t === "string") return t;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

function errorMessage(err: unknown): string {
  let cur: unknown = err;
  let msg = err instanceof Error ? err.message : String(err);
  for (let i = 0; i < 5 && cur; i++) {
    if (cur instanceof Error && cur.message) msg = cur.message;
    cur = (cur as { cause?: unknown }).cause;
  }
  return msg;
}

/* ============================================================================ routines, memory, ingestion */

/** Started by a Temporal Schedule; posts the routine prompt into the bot's queue. */
export async function routineWorkflow(input: { routineId: string }): Promise<void> {
  const agent = agentActs();
  const msg = await agent.prepareRoutineRun({ routineId: input.routineId });
  if (!msg) return; // disabled or deleted
  await agent.deliverInbound({ message: msg });
}

export async function consolidateMemoryWorkflow(input: { teamId: string; botId: string }): Promise<void> {
  const stats = await memoryActs().consolidateMemories(input);
  log.info("memory consolidated", { botId: input.botId, ...stats });
}

export async function ingestSourceWorkflow(input: { sourceId: string }): Promise<{ chunks: number; rejected: number; skipped: boolean }> {
  return memoryActs().ingestSource(input);
}

/** Scheduled every few minutes: stop bot computers that have been idle past their limit. */
export async function computerJanitorWorkflow(): Promise<void> {
  await agentActs().reapIdleComputers();
}
