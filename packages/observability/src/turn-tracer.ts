import { createTraceId, startObservation, type LangfuseAgent, type LangfuseTool, type LangfuseSpan } from "@langfuse/tracing";
import { mergeUsage, partsToText, truncate, type AgentEvent, type ContentPart, type UsageSnapshot } from "@orrery/core";

/**
 * Maps one agent turn's normalized events onto Langfuse observations:
 *
 *   turn (agent)                     input = prompt, output = final assistant text
 *   ├─ route (event)                 Clef routing decision + probabilities
 *   ├─ recall (retriever)            memories / knowledge injected into the prompt
 *   ├─ <tool title> (tool)           one per toolCallId, ends on completed/failed
 *   │   └─ approval (event)          policy / guardrail / human decision
 *   └─ <model> (generation)          usage (tokens, Kiro credits), stop reason
 *
 * Works the same for Kiro ACP turns and OpenAI-compatible tool loops, because both emit the
 * same AgentEvent vocabulary.
 */
export interface TurnTraceContext {
  runId: string;
  botId: string;
  botName: string;
  threadId: string;
  teamId: string;
  userId?: string | null;
  provider: string;
  model?: string | null;
  input: ContentPart[];
  channel: string;
  /** Deterministic Langfuse trace id for the run (all activities of one turn share it). */
  traceId?: string;
}

/** 16 hex chars for a synthetic parent span id. */
function spanId(): string {
  let s = "";
  for (let i = 0; i < 16; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

export function parentContext(traceId: string | undefined) {
  return traceId ? { parentSpanContext: { traceId, spanId: spanId(), traceFlags: 1, isRemote: true } } : {};
}

/** Deterministic trace id from the run id, so every activity of a turn lands in one trace. */
export async function traceIdForRun(runId: string): Promise<string> {
  return createTraceId(runId);
}

/** One-shot observation inside a run's trace (used by short activities). */
export function observeInRun(traceId: string | undefined, name: string, asType: "span" | "event" | "retriever" | "tool" | "generation" | "guardrail", attrs: Record<string, unknown>): { end(attrs?: Record<string, unknown>): void } {
  const o = startObservation(name, attrs as never, { asType: asType as never, ...parentContext(traceId) }) as unknown as { update(a: unknown): void; end(): void };
  return {
    end: (more) => {
      if (more) o.update(more);
      o.end();
    },
  };
}

export class TurnTracer {
  private readonly root: LangfuseAgent;
  private readonly tools = new Map<string, LangfuseTool>();
  private usage: UsageSnapshot = {};
  private text = "";
  private model: string | null;
  private ended = false;
  private readonly startedAt = new Date();

  constructor(private readonly ctx: TurnTraceContext) {
    this.model = ctx.model ?? null;
    this.root = startObservation(
      "turn",
      {
        input: truncate(partsToText(ctx.input), 20_000),
        metadata: { runId: ctx.runId, botId: ctx.botId, bot: ctx.botName, threadId: ctx.threadId, teamId: ctx.teamId, provider: ctx.provider, channel: ctx.channel },
      },
      { asType: "agent", ...parentContext(ctx.traceId) },
    );
    // Trace-level attributes (Langfuse OTel semantic keys): sessions group a thread's turns.
    this.root.otelSpan.setAttributes({
      "langfuse.trace.name": `${ctx.botName} turn`,
      "session.id": ctx.threadId,
      ...(ctx.userId ? { "user.id": ctx.userId } : {}),
      "langfuse.trace.tags": [ctx.provider, ctx.channel],
      "langfuse.trace.metadata": JSON.stringify({ botId: ctx.botId, runId: ctx.runId, teamId: ctx.teamId }),
    });
  }

  get traceId(): string {
    return this.root.traceId;
  }

  /** Make child spans (e.g. HTTP to providers) nest under the turn. */
  get span(): LangfuseSpan | LangfuseAgent {
    return this.root;
  }

  on(e: AgentEvent): void {
    if (this.ended) return;
    switch (e.type) {
      case "turn.started":
        if (e.model) this.model = e.model;
        break;
      case "route.decided":
        this.root.startObservation("route", { input: { reason: e.reason }, output: { provider: e.provider, model: e.model ?? null }, metadata: e.scores ?? {} }, { asType: "event" });
        break;
      case "memory.recalled":
        this.root.startObservation("recall.memory", { output: e.items.map((i) => ({ id: i.id, kind: i.kind, score: i.score, content: truncate(i.content, 300) })) }, { asType: "retriever" }).end();
        break;
      case "knowledge.retrieved":
        this.root.startObservation("recall.knowledge", { output: e.items }, { asType: "retriever" }).end();
        break;
      case "message.delta":
        if (e.part.type === "text") this.text += e.part.text;
        break;
      case "tool.call": {
        if (this.tools.has(e.call.toolCallId)) break;
        const t = this.root.startObservation(
          e.call.title,
          { input: e.call.rawInput ?? null, metadata: { kind: e.call.kind, toolCallId: e.call.toolCallId, ...(e.call.identity ? { identity: e.call.identity } : {}) } },
          { asType: "tool" },
        );
        this.tools.set(e.call.toolCallId, t);
        if (e.call.status === "completed" || e.call.status === "failed") this.endTool(e.call.toolCallId, e.call.status, e.call.rawOutput, e.call.failureReason);
        break;
      }
      case "tool.update":
        if (e.patch.status === "completed" || e.patch.status === "failed") this.endTool(e.toolCallId, e.patch.status, e.patch.rawOutput ?? e.patch.content, e.patch.failureReason);
        break;
      case "approval.requested":
        (this.tools.get(e.toolCall.toolCallId) ?? this.root).startObservation("approval.requested", { input: { options: e.options, consent: e.consent ?? null }, metadata: e.policy }, { asType: "event" });
        break;
      case "approval.resolved":
        this.root.startObservation("approval.resolved", { output: { outcome: e.outcome, optionKind: e.optionKind ?? null, decidedBy: e.decidedBy, actor: e.actor ?? null } }, { asType: "event" });
        break;
      case "usage":
        this.usage = mergeUsage(this.usage, e.usage);
        break;
      case "rate_limited":
      case "notice":
        this.root.startObservation(e.type, { input: e, level: e.type === "rate_limited" ? "WARNING" : "DEFAULT" }, { asType: "event" });
        break;
      case "turn.completed":
        if (e.usage) this.usage = mergeUsage(this.usage, e.usage);
        this.finish(e.stopReason, null);
        break;
      case "turn.failed":
        this.finish("error", e.error.message);
        break;
      case "turn.interrupted":
        this.finish("interrupted", e.reason);
        break;
      default:
        break;
    }
  }

  private endTool(id: string, status: string, output: unknown, failure?: string): void {
    const t = this.tools.get(id);
    if (!t) return;
    t.update({ output: output ?? null, ...(status === "failed" ? { level: failure === "denied" ? "WARNING" : "ERROR", statusMessage: failure ?? "failed" } : {}) });
    t.end();
    this.tools.delete(id);
  }

  private finish(stop: string, error: string | null): void {
    if (this.ended) return;
    this.ended = true;
    for (const id of [...this.tools.keys()]) this.endTool(id, "failed", null, "cancelled");
    const usageDetails: Record<string, number> = {};
    if (this.usage.inputTokens !== undefined) usageDetails.input = this.usage.inputTokens;
    if (this.usage.outputTokens !== undefined) usageDetails.output = this.usage.outputTokens;
    if (this.usage.cachedReadTokens !== undefined) usageDetails.cache_read_input_tokens = this.usage.cachedReadTokens;
    if (this.usage.thoughtTokens !== undefined) usageDetails.reasoning = this.usage.thoughtTokens;
    for (const [unit, v] of Object.entries(this.usage.metering ?? {})) usageDetails[`kiro_${unit}`] = v;
    const gen = this.root.startObservation(
      this.model ?? this.ctx.provider,
      {
        model: this.model ?? this.ctx.provider,
        output: truncate(this.text, 20_000),
        usageDetails,
        ...(this.usage.costUsd !== undefined ? { costDetails: { total: this.usage.costUsd } } : {}),
        completionStartTime: this.startedAt,
        metadata: { stopReason: stop, contextPercent: this.usage.contextPercent ?? null, turnDurationMs: this.usage.turnDurationMs ?? null },
        ...(error ? { level: "ERROR" as const, statusMessage: error } : {}),
      },
      { asType: "generation" },
    );
    gen.end();
    this.root.update({ output: truncate(this.text, 20_000), ...(error ? { level: "ERROR" as const, statusMessage: error } : {}), metadata: { stopReason: stop } });
    this.root.end();
  }

  /** Ensure the trace is closed even if the activity throws. */
  close(reason = "aborted"): void {
    this.finish(reason, reason === "aborted" ? "turn aborted" : null);
  }
}
