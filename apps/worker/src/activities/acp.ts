import { ApplicationFailure, Context } from "@temporalio/activity";
import {
  OrreryError,
  applyGuardrail,
  evaluatePolicy,
  isOrreryError,
  mergeUsage,
  newId,
  nowIso,
  signToken,
  type AgentEvent,
  type Bot,
  type PermissionOption,
  type UsageSnapshot,
} from "@orrery/core";
import {
  connectWebSocket,
  createAdapter,
  runAcpTurn,
  toWireMcpServer,
  type McpServerWire,
  type NormalizedPermission,
  type PermissionDecision,
  type TurnController,
  type TurnProgress,
} from "@orrery/acp";
import { approvals, bots, runs, secrets, steering, threads } from "@orrery/db";
import { TurnTracer } from "@orrery/observability";
import { assessToolRisk } from "@orrery/providers";
import { MCP_TOKEN_AUDIENCE } from "@orrery/tools";
import type { AcpActivities, AcpTurnInput, TurnOutcome } from "@orrery/workflows";
import { gatewayToken } from "../computers.js";
import type { WorkerDeps } from "../context.js";
import { RunEventSink } from "../event-sink.js";
import type { StoredRunInput } from "./agent.js";

/** Persisted in Temporal heartbeat details: everything a retried attempt needs to resume. */
interface AcpHeartbeat extends TurnProgress {
  computerId: string;
}

function pickOption(options: PermissionOption[], kinds: Array<PermissionOption["kind"]>): PermissionOption | undefined {
  for (const k of kinds) {
    const o = options.find((x) => x.kind === k);
    if (o) return o;
  }
  return undefined;
}

/** MCP servers handed to the agent session: the Orrery platform server plus the bot's own. */
export async function sessionMcpServers(deps: WorkerDeps, bot: Bot, threadId: string, userId: string | null): Promise<McpServerWire[]> {
  const token = signToken(
    { sub: bot.id, aud: MCP_TOKEN_AUDIENCE, exp: Math.floor(Date.now() / 1000) + 7 * 86_400, team: bot.teamId, thread: threadId, user: userId },
    deps.env.MCP_TOKEN_SECRET,
  );
  const base = (process.env.INTERNAL_API_URL ?? deps.env.PUBLIC_BASE_URL).replace(/\/+$/, "");
  const servers: McpServerWire[] = [toWireMcpServer({ type: "http", name: "orrery", url: `${base}/mcp`, headers: [{ name: "authorization", value: `Bearer ${token}` }] })];
  for (const s of bot.mcpServers) {
    if (s.type === "stdio") {
      const env = await Promise.all(s.env.map(async (e) => ({ name: e.name, value: await secrets.resolve(deps.db, bot.teamId, e.value, deps.env.ENCRYPTION_KEY) })));
      servers.push(toWireMcpServer({ type: "stdio", name: s.name, command: s.command, args: s.args, env }));
    } else {
      const headers = await Promise.all(s.headers.map(async (h) => ({ name: h.name, value: await secrets.resolve(deps.db, bot.teamId, h.value, deps.env.ENCRYPTION_KEY) })));
      servers.push(toWireMcpServer({ type: s.type, name: s.name, url: s.url, headers }));
    }
  }
  return servers;
}

export function createAcpActivities(deps: WorkerDeps): AcpActivities {
  const { db, log, listener, providers } = deps;

  return {
    async runAcpTurn(input: AcpTurnInput): Promise<TurnOutcome> {
      const ctx = Context.current();
      const p = input.prepared;
      const bot = await bots.getById(db, p.botId);
      const thread = await threads.getById(db, p.threadId);
      const stored = await runs.getInput<StoredRunInput>(db, p.runId);
      if (!bot || !thread || !stored) throw ApplicationFailure.create({ type: "not_found", message: "bot, thread or run input missing", nonRetryable: true });
      if (p.binding.kind === "openai") throw ApplicationFailure.create({ type: "bad_request", message: "runAcpTurn needs an ACP binding", nonRetryable: true });

      const previous = ctx.info.heartbeatDetails as AcpHeartbeat | undefined;
      const resumable = previous?.promptSent && previous.computerId === input.computer.computerId && previous.sessionId;
      const tracer = new TurnTracer({
        runId: p.runId,
        botId: bot.id,
        botName: bot.name,
        threadId: p.threadId,
        teamId: p.teamId,
        userId: p.authorUserId,
        provider: input.computer.agentKind,
        model: p.binding.kind === "kiro-acp" ? (p.binding.modelId ?? null) : (p.binding.modelId ?? null),
        input: p.inputParts,
        channel: thread.channel,
        traceId: stored.traceId,
      });
      const sink = await RunEventSink.open(db, { runId: p.runId, teamId: p.teamId, botId: p.botId, threadId: p.threadId }, tracer);
      let usage: UsageSnapshot = {};
      let model: string | null = p.binding.kind === "kiro-acp" ? (p.binding.modelId ?? null) : null;
      const onEvent = (e: AgentEvent) => {
        if (e.type === "usage") usage = mergeUsage(usage, e.usage);
        if (e.type === "turn.completed" && e.usage) usage = mergeUsage(usage, e.usage);
        if (e.type === "turn.started" && e.model) model = e.model;
        if (e.type === "config.changed") {
          const m = e.options.find((o) => o.id === "model");
          if (typeof m?.currentValue === "string") model = m.currentValue;
        }
        sink.push(e);
      };

      // Heartbeat continuously (liveness while waiting on humans) with resume details.
      let progress: AcpHeartbeat = {
        sessionId: (resumable ? previous!.sessionId : thread.acpSessionId) ?? null,
        lastSeq: resumable ? previous!.lastSeq : -1,
        agentEpoch: resumable ? previous!.agentEpoch : null,
        promptSent: Boolean(resumable),
        computerId: input.computer.computerId,
      };
      const beat = () => ctx.heartbeat(progress);
      beat();
      const beatTimer = setInterval(beat, 10_000);
      let savedSession: string | null = thread.acpSessionId ?? null;

      // Steering: the API writes to `steering` and NOTIFYs; we inject into the live turn.
      let controller: TurnController | null = null;
      const unsubSteer = await listener.subscribe("orrery_steering", (runId) => {
        if (runId !== p.runId || !controller) return;
        void (async () => {
          for (const s of await steering.takePending(db, p.runId)) {
            const ok = await controller!.steer(s.parts).catch(() => false);
            if (!ok) sink.push({ type: "notice", severity: "warning", title: "This agent does not support steering a running turn; the message will be sent as the next turn." });
          }
        })();
      });

      // Approval decisions arrive via NOTIFY from the API (compare-and-set in Postgres).
      const waiters = new Map<string, () => void>();
      const unsubApprovals = await listener.subscribe("orrery_approvals", (id) => waiters.get(id)?.());

      const decidePermission = async (perm: NormalizedPermission, signal: AbortSignal): Promise<PermissionDecision> => {
        const verdict = evaluatePolicy(bot.policy, perm.facts);
        const risk = verdict.effect === "deny" ? null : await assessToolRisk(providers.decisions(), perm.facts, { title: perm.toolCall.title, rawInput: perm.toolCall.rawInput, botInstructions: bot.instructions }, signal);
        const final = applyGuardrail(verdict, risk, bot.policy.guardrail);
        const autoId = `auto_${perm.toolCall.toolCallId}`;
        if (final.effect === "allow" || final.effect === "deny") {
          const opt = final.effect === "allow" ? pickOption(perm.options, ["allow_once", "allow_always"]) : pickOption(perm.options, ["reject_once", "reject_always"]);
          sink.push({
            type: "approval.resolved",
            approvalId: autoId,
            outcome: opt ? "selected" : "cancelled",
            ...(opt ? { optionKind: opt.kind } : {}),
            decidedBy: final.reason?.startsWith("guardrail") ? "guardrail" : "policy",
            reason: final.matchedRule ? `rule ${final.matchedRule}` : (final.reason ?? "policy"),
          });
          // Never persist consent from an automatic decision; one-time options only.
          return opt ? { outcome: "selected", optionId: opt.optionId } : { outcome: "cancelled" };
        }

        // Ask a human.
        const approvalId = newId("approval");
        const expiresAt = new Date(Date.now() + bot.policy.approvalTimeoutMinutes * 60_000).toISOString();
        const decided = new Promise<void>((resolve) => waiters.set(approvalId, resolve));
        await approvals.create(db, {
          id: approvalId,
          teamId: p.teamId,
          botId: p.botId,
          threadId: p.threadId,
          runId: p.runId,
          toolCallId: perm.toolCall.toolCallId,
          title: perm.toolCall.title,
          kind: perm.toolCall.kind,
          capability: perm.facts.capability,
          resource: perm.facts.resource,
          rawInput: perm.toolCall.rawInput ?? null,
          options: perm.options,
          consent: perm.persistable && bot.policy.allowPersistentConsent ? (perm.consent ?? { persistableConsent: true }) : null,
          mcpTool: perm.identity ? { ...(perm.identity.server ? { server: perm.identity.server } : {}), ...(perm.identity.tool ? { tool: perm.identity.tool } : {}), ...(perm.annotations ? { annotations: perm.annotations } : {}) } : null,
          risk: final.risk ?? risk ?? null,
          expiresAt,
        });
        await sink.pushNow({
          type: "approval.requested",
          approvalId,
          toolCall: perm.toolCall,
          options: perm.options,
          ...(perm.consent ? { consent: perm.consent } : {}),
          policy: { action: "ask", ...(final.matchedRule ? { matchedRule: final.matchedRule } : {}), ...(final.risk !== undefined ? { risk: final.risk } : {}), ...(final.reason ? { reason: final.reason } : {}) },
          expiresAt,
        });
        const timeout = new Promise<"timeout">((resolve) => {
          const t = setTimeout(() => resolve("timeout"), bot.policy.approvalTimeoutMinutes * 60_000);
          t.unref();
          signal.addEventListener("abort", () => clearTimeout(t), { once: true });
        });
        const aborted = new Promise<"aborted">((resolve) => signal.addEventListener("abort", () => resolve("aborted"), { once: true }));
        // The decision might have landed before we subscribed: check once.
        const pre = await approvals.getById(db, approvalId);
        const race = pre && pre.status !== "pending" ? "decided" : await Promise.race([decided.then(() => "decided" as const), timeout, aborted]);
        waiters.delete(approvalId);
        if (race === "aborted") {
          await approvals.decide(db, approvalId, "cancelled", { optionId: null, optionKind: null, by: "system", at: nowIso() });
          sink.push({ type: "approval.resolved", approvalId, outcome: "cancelled", decidedBy: "system" });
          return { outcome: "cancelled" };
        }
        if (race === "timeout") {
          await approvals.decide(db, approvalId, "expired", { optionId: null, optionKind: null, by: "timeout", at: nowIso() });
          sink.push({ type: "approval.resolved", approvalId, outcome: "expired", decidedBy: "timeout" });
          const reject = pickOption(perm.options, ["reject_once"]);
          return reject ? { outcome: "selected", optionId: reject.optionId } : { outcome: "cancelled" };
        }
        const a = await approvals.getById(db, approvalId);
        const d = a?.decision;
        if (!a || a.status === "cancelled" || !d?.optionId) {
          sink.push({ type: "approval.resolved", approvalId, outcome: "cancelled", decidedBy: "user", ...(d?.by ? { actor: d.by } : {}) });
          return { outcome: "cancelled" };
        }
        sink.push({ type: "approval.resolved", approvalId, outcome: "selected", optionKind: (d.optionKind ?? undefined) as never, decidedBy: "user", actor: d.by });
        return {
          outcome: "selected",
          optionId: d.optionId,
          ...(d.persist && bot.policy.allowPersistentConsent ? { persist: { scope: d.persist.scope, resource: d.persist.resource } } : {}),
        };
      };

      const adapter = createAdapter(p.binding);
      const mcpServers = await sessionMcpServers(deps, bot, p.threadId, p.authorUserId);
      try {
        const result = await runAcpTurn(
          {
            connect: () => connectWebSocket({ url: input.computer.endpoint, token: gatewayToken(deps.env, input.computer.computerId) }),
            adapter,
            viaGateway: true,
            logger: log.child({ runId: p.runId }),
          },
          {
            requestKey: p.runId,
            messageId: p.assistantMessageId,
            sessionId: progress.sessionId,
            session: {
              cwd: input.computer.cwd,
              mcpServers,
              binding: {
                ...(p.binding.modeId ? { modeId: p.binding.modeId } : {}),
                ...(p.binding.modelId ? { modelId: p.binding.modelId } : {}),
                ...(p.binding.kind === "kiro-acp" && p.binding.effort ? { effort: p.binding.effort } : {}),
              },
            },
            prompt: stored.promptParts,
            promptForNewSession: stored.promptForNewSession,
            resume: resumable ? { sessionId: previous!.sessionId!, afterSeq: previous!.lastSeq, agentEpoch: previous!.agentEpoch, promptSent: true } : null,
          },
          {
            onEvent,
            decidePermission,
            onReady: (c) => {
              controller = c;
            },
            onProgress: (pr) => {
              progress = { ...pr, computerId: input.computer.computerId };
              if (pr.sessionId && pr.sessionId !== savedSession) {
                savedSession = pr.sessionId;
                void threads.setAcpSession(db, p.threadId, pr.sessionId, pr.agentEpoch).catch(() => undefined);
              }
            },
            onElicitation: async (req) => {
              // Structured input requests are surfaced to the UI; v1 declines them in unattended runs.
              onEvent({ type: "elicitation.requested", elicitationId: String(req.elicitationId ?? newId("event")), message: req.message, mode: String(req.mode), ...(req.url ? { url: req.url } : {}), ...(req.requestedSchema ? { schema: req.requestedSchema } : {}) });
              return { action: "decline" };
            },
          },
          ctx.cancellationSignal,
        );
        await sink.close();
        tracer.close("completed");
        return {
          stopReason: result.stopReason === "interrupted" ? "interrupted" : (result.stopReason as TurnOutcome["stopReason"]),
          usage,
          model,
          sessionId: result.sessionId,
          agentEpoch: result.agentEpoch,
          error: result.stopReason === "interrupted" ? { code: "interrupted", message: "turn interrupted" } : null,
        };
      } catch (err) {
        const oe = isOrreryError(err) ? err : new OrreryError("provider_unavailable", err instanceof Error ? err.message : String(err), { cause: err });
        if (oe.code !== "interrupted") sink.push({ type: "turn.failed", error: { code: oe.code, message: oe.message, retryable: oe.retryable } });
        await sink.close();
        tracer.close("error");
        // Connection failures before the prompt was sent are safe to retry; anything after
        // the prompt reached the agent is resumed via heartbeat details, never re-prompted.
        throw ApplicationFailure.create({ type: oe.code, message: oe.message, nonRetryable: !oe.retryable || oe.code === "interrupted" });
      } finally {
        clearInterval(beatTimer);
        unsubSteer();
        unsubApprovals();
      }
    },
  };
}
