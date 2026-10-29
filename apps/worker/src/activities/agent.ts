import { ApplicationFailure, Context } from "@temporalio/activity";
import {
  OrreryError,
  applyGuardrail,
  evaluatePolicy,
  foldTranscript,
  isOrreryError,
  newId,
  nowIso,
  partsToText,
  truncate,
  type AgentEvent,
  type Bot,
  type ContentPart,
  type InboundMessage,
  type ToolKind,
  type ToolRequestFacts,
} from "@orrery/core";
import { approvals, bots, computers, delegations, events, messages, routines, runs, threads, usage } from "@orrery/db";
import { MemoryService } from "@orrery/memory";
import { KnowledgeService } from "@orrery/rag";
import { assessToolRisk, decideRoute, toOpenAIContent, type ChatMessage } from "@orrery/providers";
import { observeInRun, traceIdForRun } from "@orrery/observability";
import { findTool, openAiToolDefs, type ToolContext } from "@orrery/tools";
import type { AgentActivities, ApprovalRequest, FinalizeInput, LlmStepInput, NativeToolCall, PreparedTurn, TurnInput } from "@orrery/workflows";
import { deliverInbound, type WorkerDeps } from "../context.js";
import { RunEventSink } from "../event-sink.js";
import { parseFunctionName } from "../mcp-hub.js";
import { buildPrompt } from "../prompt.js";

export interface StoredRunInput {
  promptParts: ContentPart[];
  promptForNewSession: ContentPart[];
  systemPrompt: string;
  userText: string;
  traceId: string;
}

/** Temporal-friendly failure: non-retryable semantic errors, retryable infrastructure errors. */
export function toFailure(err: unknown): unknown {
  if (err instanceof ApplicationFailure) return err;
  if (isOrreryError(err)) return ApplicationFailure.create({ type: err.code, message: err.message, nonRetryable: !err.retryable, details: err.details ? [err.details] : [] });
  return err;
}

export async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toFailure(err);
  }
}

export function assistantMessageIdFor(runId: string): string {
  return runId.replace(/^run_/, "msg_");
}

async function loadBot(deps: WorkerDeps, botId: string): Promise<Bot> {
  const bot = await bots.getById(deps.db, botId);
  if (!bot) throw new OrreryError("not_found", `bot ${botId} not found`);
  return bot;
}

function sinkRef(p: { runId: string; teamId: string; botId: string; threadId: string }) {
  return { runId: p.runId, teamId: p.teamId, botId: p.botId, threadId: p.threadId };
}

export function toolKindFor(name: string): ToolKind {
  if (/search|recall|find|lookup|list/.test(name)) return "search";
  if (/fetch|http|browse|get_/.test(name)) return "fetch";
  if (/delete|remove|forget/.test(name)) return "delete";
  if (/save|write|create|update|append|replace|post|send|delegate/.test(name)) return "edit";
  if (/read|history|get/.test(name)) return "read";
  return "other";
}

export function factsForNativeTool(call: NativeToolCall): ToolRequestFacts {
  const parsed = parseFunctionName(call.name);
  if (parsed?.kind === "platform") return { capability: "platform", kind: toolKindFor(parsed.tool), resource: `orrery/${parsed.tool}`, tool: parsed.tool, mcpServer: "orrery" };
  if (parsed?.kind === "mcp") return { capability: "mcp", kind: toolKindFor(parsed.tool), resource: `${parsed.server}/${parsed.tool}`, mcpServer: parsed.server, tool: parsed.tool };
  return { capability: "other", kind: "other", resource: call.name };
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
  } catch {
    return { _raw: s };
  }
}

export function createAgentActivities(deps: WorkerDeps): AgentActivities {
  const { db, providers, memory, knowledge, log } = deps;

  const toolContext = (bot: Bot, p: PreparedTurn): ToolContext => ({
    db,
    memory,
    knowledge,
    bot,
    threadId: p.threadId,
    runId: p.runId,
    userId: p.authorUserId,
    deliverInbound: (m) => deliverInbound(deps, m),
    newId: (k) => newId(k),
  });

  return {
    /* ---------------------------------------------------------------- prepare */
    prepareTurn: (input: TurnInput) =>
      wrap(async () => {
        const bot = await loadBot(deps, input.botId);
        const thread = await threads.getById(db, input.threadId);
        if (!thread) throw new OrreryError("not_found", `thread ${input.threadId} not found`);
        const first = input.messages[0]!;
        const traceId = await traceIdForRun(input.runId);
        const inputParts: ContentPart[] = input.messages.flatMap((m, i) => (i ? [{ type: "text" as const, text: "\n\n" }, ...m.parts] : m.parts));
        const forced = input.messages.find((m) => m.forceProvider)?.forceProvider ?? null;

        const route = await decideRoute(providers.decisions(), bot.routing, { parts: inputParts, channel: first.channel, forced });
        const binding = route.target === "fast" && bot.routing.fast ? bot.routing.fast : bot.primary;

        await runs.start(db, {
          id: input.runId,
          teamId: input.teamId,
          botId: bot.id,
          threadId: input.threadId,
          triggerMessageId: first.messageId,
          provider: binding.kind,
          model: binding.kind === "openai" ? binding.model : binding.kind === "kiro-acp" ? (binding.modelId ?? null) : null,
          engine: binding.kind === "kiro-acp" ? binding.engine : null,
          workflowId: `turn:${input.runId}`,
          traceId,
        });
        const sink = await RunEventSink.open(db, sinkRef(input));
        sink.push({ type: "route.decided", provider: binding.kind, ...(binding.kind === "openai" ? { model: binding.model } : {}), reason: route.reason, ...(route.scores ? { scores: route.scores } : {}) });

        const query = partsToText(inputParts);
        let memoryBlock = "";
        if (bot.memory.enabled) {
          const span = observeInRun(traceId, "recall", "retriever", { input: { query: truncate(query, 2000) } });
          try {
            const [core, recalled, episodes] = await Promise.all([
              memory.coreMemory(bot.id),
              memory.recall({ teamId: bot.teamId, botId: bot.id, userId: first.author.type === "user" ? first.author.id : null, query, k: bot.memory.recallK, shareScope: bot.memory.shareScope }),
              memory.recallEpisodes({ teamId: bot.teamId, botId: bot.id, query, k: 3, excludeThreadId: input.threadId }),
            ]);
            memoryBlock = MemoryService.format(core, recalled, episodes);
            if (recalled.length) sink.push({ type: "memory.recalled", items: recalled.map((r) => ({ id: r.id, content: r.content, score: r.score, kind: r.kind })) });
            span.end({ output: { memories: recalled.length, episodes: episodes.length } });
          } catch (err) {
            span.end({ level: "WARNING", statusMessage: String(err) });
            log.warn({ err: String(err), runId: input.runId }, "memory recall failed; continuing without memory");
          }
        }
        let knowledgeBlock = "";
        if (bot.knowledgeBaseIds.length) {
          try {
            const res = await knowledge.search({ teamId: bot.teamId, knowledgeBaseIds: bot.knowledgeBaseIds, query, k: 5 });
            knowledgeBlock = KnowledgeService.format(res);
            if (res.hits.length) {
              sink.push({ type: "knowledge.retrieved", items: res.hits.map((h) => ({ chunkId: h.chunkId, sourceTitle: h.sourceTitle, score: h.score, excerpt: truncate(h.content, 300) })) });
            }
          } catch (err) {
            log.warn({ err: String(err), runId: input.runId }, "knowledge search failed; continuing");
          }
        }
        const ids = new Set(input.messages.map((m) => m.messageId));
        const history = (await messages.list(db, input.threadId, 24)).filter((m) => !ids.has(m.id));
        const built = buildPrompt({ bot, messages: input.messages, memoryBlock, knowledgeBlock, nowIso: nowIso(), history });
        const stored: StoredRunInput = { ...built, traceId };
        await runs.setInput(db, input.runId, stored as unknown as Record<string, unknown>);
        await sink.close();
        return {
          runId: input.runId,
          teamId: input.teamId,
          botId: bot.id,
          threadId: input.threadId,
          botName: bot.name,
          target: route.target,
          binding,
          assistantMessageId: assistantMessageIdFor(input.runId),
          inputParts: inputParts.filter((p) => p.type === "text").slice(0, 20),
          maxSteps: binding.kind === "openai" ? binding.maxSteps : 1,
          approvalTimeoutMinutes: bot.policy.approvalTimeoutMinutes,
          replyTo: input.messages.find((m) => m.replyTo)?.replyTo ?? null,
          authorUserId: first.author.type === "user" ? first.author.id : null,
        } satisfies PreparedTurn;
      }),

    ensureComputer: ({ botId }) =>
      wrap(async () => {
        const bot = await loadBot(deps, botId);
        if (!bot.computer.enabled && bot.primary.kind !== "openai") {
          // Kiro still needs a harness host; a computer without tools is just a sandboxed runtime.
          log.info({ botId }, "computer disabled in spec; starting a minimal harness host");
        }
        return deps.computers.ensure(bot);
      }),

    /* ---------------------------------------------------------------- native tool loop */
    llmStep: (input: LlmStepInput) =>
      wrap(async () => {
        const p = input.prepared;
        if (p.binding.kind !== "openai") throw new OrreryError("bad_request", "llmStep requires an OpenAI-compatible binding");
        const binding = p.binding;
        const bot = await loadBot(deps, p.botId);
        const stored = await runs.getInput<StoredRunInput>(db, p.runId);
        if (!stored) throw new OrreryError("not_found", "run input missing");
        const client = providers.get(binding.providerId);
        const ctx = Context.current();

        const history = (await messages.list(db, p.threadId, 30)).filter((m) => m.runId !== p.runId && m.id !== p.assistantMessageId);
        const trigger = new Set((await runs.getById(db, p.runId))?.triggerMessageId ?? []);
        const chat: ChatMessage[] = [{ role: "system", content: stored.systemPrompt }];
        for (const m of history) {
          if (trigger.has(m.id)) continue;
          chat.push({ role: m.role === "assistant" ? "assistant" : "user", content: toOpenAIContent(m.parts, client.config.capabilities.vision) });
        }
        chat.push({ role: "user", content: toOpenAIContent(stored.promptParts, client.config.capabilities.vision) });
        for (const s of input.scratch) {
          if (s.role === "assistant") {
            chat.push({ role: "assistant", content: s.content, ...(s.toolCalls?.length ? { tool_calls: s.toolCalls.map((t) => ({ id: t.id, type: "function" as const, function: { name: t.name, arguments: t.arguments } })) } : {}) });
          } else {
            chat.push({ role: "tool", tool_call_id: s.toolCallId!, content: s.content ?? "" });
          }
        }
        const tools = [...openAiToolDefs(), ...(await deps.mcp.toolDefs(bot))];

        const sink = await RunEventSink.open(db, sinkRef(p));
        if (input.step === 0) sink.push({ type: "turn.started", provider: "openai", model: binding.model });
        let lastBeat = 0;
        const span = observeInRun(stored.traceId, `${binding.model} step ${input.step}`, "generation", { model: binding.model, input: chat.slice(-6) });
        const r = await client.chatStream(
          { model: binding.model, messages: chat, tools, ...(binding.temperature !== undefined ? { temperature: binding.temperature } : {}), signal: ctx.cancellationSignal },
          (d) => {
            if (d.text) sink.push({ type: "message.delta", messageId: p.assistantMessageId, part: { type: "text", text: d.text } });
            if (d.reasoning) sink.push({ type: "thought.delta", messageId: p.assistantMessageId, part: { type: "text", text: d.reasoning } });
            if (Date.now() - lastBeat > 5000) {
              lastBeat = Date.now();
              ctx.heartbeat({ step: input.step });
            }
          },
        );
        span.end({ output: r.content || r.toolCalls, usageDetails: { input: r.usage.inputTokens ?? 0, output: r.usage.outputTokens ?? 0 } });
        const toolCalls: NativeToolCall[] = r.toolCalls.map((t) => ({ id: t.id, name: t.function.name, arguments: t.function.arguments }));
        for (const t of toolCalls) {
          const facts = factsForNativeTool(t);
          sink.push({
            type: "tool.call",
            call: {
              toolCallId: t.id,
              title: facts.tool ? `${facts.mcpServer ?? "tool"}/${facts.tool}` : t.name,
              kind: facts.kind,
              status: "pending",
              rawInput: safeJson(t.arguments),
              identity: { source: facts.capability === "mcp" ? "mcp" : "platform", ...(facts.mcpServer ? { server: facts.mcpServer } : {}), ...(facts.tool ? { tool: facts.tool } : {}) },
            },
          });
        }
        sink.push({ type: "usage", usage: r.usage });
        await sink.close();
        return { text: r.content, toolCalls, finishReason: r.finishReason, usage: r.usage, model: r.model };
      }),

    evaluateToolCall: ({ prepared, toolCall }) =>
      wrap(async () => {
        const bot = await loadBot(deps, prepared.botId);
        const facts = factsForNativeTool(toolCall);
        const verdict = evaluatePolicy(bot.policy, facts);
        const risk = verdict.effect === "deny" ? null : await assessToolRisk(providers.decisions(), facts, { title: toolCall.name, rawInput: safeJson(toolCall.arguments), botInstructions: bot.instructions });
        const final = applyGuardrail(verdict, risk, bot.policy.guardrail);
        if (final.effect !== "ask") {
          const sink = await RunEventSink.open(db, sinkRef(prepared));
          sink.push({
            type: "approval.resolved",
            approvalId: `auto_${toolCall.id}`,
            outcome: "selected",
            optionKind: final.effect === "allow" ? "allow_once" : "reject_once",
            decidedBy: final.reason?.startsWith("guardrail") ? "guardrail" : "policy",
            ...(final.matchedRule ? { reason: `rule ${final.matchedRule}` } : final.reason ? { reason: final.reason } : {}),
          });
          await sink.close();
        }
        return {
          toolCallId: toolCall.id,
          effect: final.effect,
          risk: final.risk ?? risk ?? null,
          reason: final.reason ?? final.matchedRule ?? "policy",
          title: toolCall.name,
          kind: facts.kind,
          capability: facts.capability,
          resource: facts.resource,
        };
      }),

    openApproval: (req: ApprovalRequest) =>
      wrap(async () => {
        const p = req.prepared;
        const expiresAt = new Date(Date.now() + p.approvalTimeoutMinutes * 60_000).toISOString();
        await approvals.create(db, {
          id: req.approvalId,
          teamId: p.teamId,
          botId: p.botId,
          threadId: p.threadId,
          runId: p.runId,
          toolCallId: req.toolCall.id,
          title: req.toolCall.name,
          kind: req.evaluation.kind,
          capability: req.evaluation.capability,
          resource: req.evaluation.resource,
          rawInput: safeJson(req.toolCall.arguments),
          options: req.options,
          consent: null,
          mcpTool: null,
          risk: req.evaluation.risk,
          expiresAt,
        });
        const sink = await RunEventSink.open(db, sinkRef(p));
        await sink.pushNow({
          type: "approval.requested",
          approvalId: req.approvalId,
          toolCall: { toolCallId: req.toolCall.id, title: req.toolCall.name, kind: req.evaluation.kind, status: "pending", rawInput: safeJson(req.toolCall.arguments) },
          options: req.options,
          policy: { action: "ask", reason: req.evaluation.reason, ...(req.evaluation.risk !== null ? { risk: req.evaluation.risk } : {}) },
          expiresAt,
        });
        await sink.close();
        return { expiresAt };
      }),

    closeApproval: ({ prepared, approvalId, outcome, optionKind, actor, decidedBy }) =>
      wrap(async () => {
        if (outcome === "expired") await approvals.decide(db, approvalId, "expired", { optionId: null, optionKind: null, by: "timeout", at: nowIso() });
        const sink = await RunEventSink.open(db, sinkRef(prepared));
        await sink.pushNow({ type: "approval.resolved", approvalId, outcome, ...(optionKind ? { optionKind: optionKind as never } : {}), decidedBy, actor });
        await sink.close();
      }),

    executeTool: ({ prepared, toolCall }) =>
      wrap(async () => {
        const bot = await loadBot(deps, prepared.botId);
        const sink = await RunEventSink.open(db, sinkRef(prepared));
        sink.push({ type: "tool.update", toolCallId: toolCall.id, patch: { status: "in_progress" } });
        const parsed = parseFunctionName(toolCall.name);
        let ok = true;
        let output: string;
        const span = observeInRun((await runs.getInput<StoredRunInput>(db, prepared.runId))?.traceId, toolCall.name, "tool", { input: safeJson(toolCall.arguments) });
        try {
          if (parsed?.kind === "platform") {
            const tool = findTool(parsed.tool);
            if (!tool) throw new OrreryError("not_found", `unknown platform tool ${parsed.tool}`);
            output = await tool.run(toolContext(bot, prepared), safeJson(toolCall.arguments));
          } else if (parsed?.kind === "mcp") {
            const r = await deps.mcp.call(bot, parsed.server, parsed.tool, safeJson(toolCall.arguments), Context.current().cancellationSignal);
            ok = r.ok;
            output = r.text;
          } else {
            ok = false;
            output = `Unknown tool ${toolCall.name}`;
          }
        } catch (err) {
          ok = false;
          output = `Tool failed: ${err instanceof Error ? err.message : String(err)}`;
        }
        span.end({ output: truncate(output, 4000), ...(ok ? {} : { level: "ERROR" }) });
        sink.push({
          type: "tool.update",
          toolCallId: toolCall.id,
          patch: { status: ok ? "completed" : "failed", content: [{ type: "content", content: { type: "text", text: truncate(output, 20_000) } }], ...(ok ? {} : { failureReason: "error" as const }) },
        });
        await sink.close();
        return { ok, output };
      }),

    recordToolDenied: ({ prepared, toolCall, reason }) =>
      wrap(async () => {
        const sink = await RunEventSink.open(db, sinkRef(prepared));
        sink.push({ type: "tool.update", toolCallId: toolCall.id, patch: { status: "failed", failureReason: "denied", content: [{ type: "content", content: { type: "text", text: reason } }] } });
        await sink.close();
      }),

    /* ---------------------------------------------------------------- finalize */
    finalizeTurn: (input: FinalizeInput) =>
      wrap(async () => {
        const p = input.prepared;
        const bot = await loadBot(deps, p.botId);
        const list = (await events.listForRun(db, p.runId)).map((e) => e.event);
        const t = foldTranscript(list);
        const sink = await RunEventSink.open(db, sinkRef(p));
        const hasTerminal = list.some((e) => e.type === "turn.completed" || e.type === "turn.failed" || e.type === "turn.interrupted");
        if (!hasTerminal) {
          if (input.status === "completed") sink.push({ type: "turn.completed", stopReason: input.outcome.stopReason === "max_tokens" || input.outcome.stopReason === "max_turn_requests" ? input.outcome.stopReason : "end_turn", usage: input.outcome.usage });
          else if (input.status === "cancelled") sink.push({ type: "turn.completed", stopReason: "cancelled" });
          else if (input.status === "interrupted") sink.push({ type: "turn.interrupted", reason: input.outcome.error?.message ?? "interrupted", resumable: true });
          else sink.push({ type: "turn.failed", error: { code: input.outcome.error?.code ?? "internal", message: input.outcome.error?.message ?? "turn failed", retryable: false } });
        }
        await sink.close();

        const text = t.assistantText.trim();
        const usageSnap = { ...t.usage, ...input.outcome.usage, ...(t.usage.metering || input.outcome.usage.metering ? { metering: { ...(t.usage.metering ?? {}), ...(input.outcome.usage.metering ?? {}) } } : {}) };
        if (text || t.tools.length) {
          await messages.insert(db, {
            id: p.assistantMessageId,
            teamId: p.teamId,
            threadId: p.threadId,
            role: "assistant",
            author: { type: "bot", id: bot.id, name: bot.name },
            parts: [{ type: "text", text: t.assistantText }],
            runId: p.runId,
            meta: {
              status: input.status,
              stopReason: input.outcome.stopReason,
              tools: t.tools.map((x) => ({ id: x.toolCallId, title: x.title, kind: x.kind, status: x.status, failureReason: x.failureReason ?? null })),
              usage: usageSnap,
            },
          });
        } else if (input.status !== "completed") {
          await messages.insert(db, {
            id: p.assistantMessageId,
            teamId: p.teamId,
            threadId: p.threadId,
            role: "system",
            author: { type: "system", id: "orrery" },
            parts: [{ type: "text", text: input.status === "cancelled" ? "Turn cancelled." : `Turn ${input.status}: ${input.outcome.error?.message ?? "unknown error"}` }],
            runId: p.runId,
            meta: { status: input.status },
          });
        }
        await runs.finish(db, p.runId, {
          status: input.status,
          stopReason: input.outcome.stopReason === "error" || input.outcome.stopReason === "interrupted" ? null : input.outcome.stopReason,
          usage: usageSnap,
          error: input.outcome.error ?? null,
          model: input.outcome.model,
        });
        await approvals.cancelForRun(db, p.runId);
        await usage.record(db, { runId: p.runId, teamId: p.teamId, botId: p.botId, provider: p.binding.kind, model: input.outcome.model, usage: usageSnap });
        await threads.touch(db, p.threadId);
        if (input.outcome.sessionId) await threads.setAcpSession(db, p.threadId, input.outcome.sessionId, input.outcome.agentEpoch ?? null);

        // Title for brand-new threads (fast model, best effort).
        const thread = await threads.getById(db, p.threadId);
        if (thread && thread.title === "New conversation") {
          const userText = partsToText(p.inputParts);
          let title = truncate(userText.replace(/\s+/g, " ").trim(), 60) || "Conversation";
          const fast = providers.modelFor("fast");
          if (fast) {
            try {
              const { value } = await fast.client.json<{ title?: string }>({
                model: fast.model,
                schemaName: "title",
                schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
                messages: [
                  { role: "system", content: "Write a short title (max 6 words, no quotes) for this conversation. Reply as JSON {\"title\": ...}." },
                  { role: "user", content: truncate(`${userText}\n\n${text}`, 3000) },
                ],
              });
              if (value.title?.trim()) title = truncate(value.title.trim(), 80);
            } catch {
              /* keep heuristic title */
            }
          }
          await threads.setTitle(db, p.threadId, title);
        }

        let episodeId: string | null = null;
        if (bot.memory.enabled && input.status === "completed" && (text || t.tools.length)) {
          episodeId = await memory.recordEpisode({
            teamId: p.teamId,
            botId: p.botId,
            threadId: p.threadId,
            runId: p.runId,
            userText: partsToText(p.inputParts),
            assistantText: t.assistantText,
            tools: t.tools.map((x) => ({ title: x.title, kind: x.kind, status: x.status })),
          });
        }

        // Delegation: report the result back to the requesting bot's conversation.
        if (p.replyTo) {
          const resultText = text || (input.status === "completed" ? "(no text output)" : `Delegated task ${input.status}.`);
          await delegations.update(db, p.replyTo.delegationId, { status: input.status === "completed" ? "completed" : "failed", result: truncate(resultText, 20_000) });
          const origin = await threads.getById(db, p.replyTo.threadId);
          if (origin) {
            const msg = await messages.insert(db, {
              teamId: p.teamId,
              threadId: origin.id,
              role: "peer",
              author: { type: "bot", id: bot.id, name: bot.name },
              parts: [{ type: "text", text: `Result of delegated task from ${bot.name}:\n\n${resultText}` }],
              meta: { delegationId: p.replyTo.delegationId, fromRunId: p.runId },
            });
            const inbound: InboundMessage = {
              messageId: msg.id,
              threadId: origin.id,
              botId: p.replyTo.botId,
              teamId: p.teamId,
              channel: "peer",
              author: { type: "bot", id: bot.id, name: bot.name },
              parts: msg.parts,
              replyTo: null,
              receivedAt: nowIso(),
            };
            await deliverInbound(deps, inbound);
          }
        }
        observeInRun((await runs.getInput<StoredRunInput>(db, p.runId))?.traceId, "finalize", "event", { output: { status: input.status, stopReason: input.outcome.stopReason, episodeId } });
        return { episodeId, needsConsolidation: Boolean(episodeId && bot.memory.autoExtract) };
      }),

    /* ---------------------------------------------------------------- routing glue */
    deliverInbound: ({ message }) => wrap(() => deliverInbound(deps, message)),

    prepareRoutineRun: ({ routineId }) =>
      wrap(async () => {
        const r = await routines.getById(db, routineId);
        if (!r || !r.enabled) return null;
        const bot = await bots.getById(db, r.botId);
        if (!bot || bot.status !== "active") return null;
        let threadId = r.threadPolicy === "reuse" ? r.threadId : null;
        if (threadId && !(await threads.getById(db, threadId))) threadId = null;
        if (!threadId) threadId = (await threads.create(db, { teamId: r.teamId, botId: r.botId, channel: "routine", createdBy: `routine:${r.id}`, title: r.name })).id;
        const msg = await messages.insert(db, {
          teamId: r.teamId,
          threadId,
          role: "user",
          author: { type: "system", id: `routine:${r.id}`, name: `Routine: ${r.name}` },
          parts: [{ type: "text", text: r.prompt }],
          meta: { routineId: r.id },
        });
        await routines.markRun(db, r.id, threadId);
        return {
          messageId: msg.id,
          threadId,
          botId: r.botId,
          teamId: r.teamId,
          channel: "routine",
          author: { type: "system", id: `routine:${r.id}`, name: `Routine: ${r.name}` },
          parts: msg.parts,
          replyTo: null,
          receivedAt: nowIso(),
        } satisfies InboundMessage;
      }),

    reapIdleComputers: () =>
      wrap(async () => {
        const allBots = new Map<string, Bot>();
        const ids = (await db.query<{ bot_id: string }>("SELECT DISTINCT bot_id FROM computers WHERE status = 'running' AND bot_id IS NOT NULL")).rows.map((r) => r.bot_id);
        for (const id of ids) {
          const b = await bots.getById(db, id);
          if (b) allBots.set(id, b);
        }
        const idle = await computers.idle(db, (row) => {
          return row.botId ? (allBots.get(row.botId)?.computer.idleMinutes ?? 60) : 60;
        });
        let stopped = 0;
        for (const c of idle) {
          if (c.botId) {
            const active = await db.query("SELECT 1 FROM runs WHERE bot_id = $1 AND status IN ('running','waiting_approval','queued') LIMIT 1", [c.botId]);
            if (active.rowCount) continue;
          }
          await deps.computers.stop(c.id);
          stopped++;
        }
        return { stopped };
      }),
  };
}

export type { AgentEvent };
