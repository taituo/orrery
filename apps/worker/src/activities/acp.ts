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
  TurnDetachedError,
  toWireMcpServer,
  type McpServerWire,
  type NormalizedPermission,
  type PermissionDecision,
  type TurnController,
  type TurnProgress,
} from "@orrery/acp";
import { approvals, bots, outbox, runs, secrets, steering, threads, withTx } from "@orrery/db";
import { TurnTracer } from "@orrery/observability";
import { assessToolRisk } from "@orrery/providers";
import { MCP_TOKEN_AUDIENCE } from "@orrery/tools";
import type { AcpActivities, AcpTurnInput, TurnOutcome } from "@orrery/workflows";
import { gatewayToken } from "../computers.js";
import { deliverInbound, type WorkerDeps } from "../context.js";
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

      // Resume point. The cursor persisted atomically with the run's events is exact: replay
      // continues right after the last persisted event. Heartbeat details (throttled by the SDK,
      // not tied to persistence) only contribute the session id; if the prompt was already sent
      // but nothing was persisted yet, the gateway reports it and the turn is adopted and
      // replayed from its start — never re-prompted.
      const fromDb = await runs.getAcpCursor<AcpHeartbeat>(db, p.runId);
      const fromBeat = ctx.info.heartbeatDetails as AcpHeartbeat | undefined;
      const sameComputer = (c: AcpHeartbeat | null | undefined): c is AcpHeartbeat => Boolean(c && c.computerId === input.computer.computerId && c.sessionId);
      const previous = sameComputer(fromDb) ? fromDb : sameComputer(fromBeat) ? { ...fromBeat, promptSent: false, lastSeq: -1 } : undefined;
      const resumable = previous?.promptSent && previous.sessionId;
      const tracer = new TurnTracer({
        runId: p.runId,
        botId: bot.id,
        botName: bot.name,
        threadId: p.threadId,
        teamId: p.teamId,
        userId: p.authorUserId,
        provider: input.computer.agentKind,
        model: p.binding.modelId ?? null,
        input: p.inputParts,
        channel: thread.channel,
        traceId: stored.traceId,
      });
      const sink = await RunEventSink.open(db, { runId: p.runId, teamId: p.teamId, botId: p.botId, threadId: p.threadId }, tracer, 60, () => progress);
      let usage: UsageSnapshot = {};
      let model: string | null = p.binding.modelId ?? null;
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

      // This bot's agent session for the conversation (each bot of a group has its own).
      const known = (await threads.acpSessionFor(db, p.threadId, p.botId))?.sessionId ?? null;
      // Heartbeat continuously (liveness while waiting on humans) with resume details.
      let progress: AcpHeartbeat = {
        sessionId: (previous?.sessionId ?? known) ?? null,
        lastSeq: resumable ? previous!.lastSeq : -1,
        agentEpoch: resumable ? previous!.agentEpoch : null,
        promptSent: Boolean(resumable),
        computerId: input.computer.computerId,
      };
      const beat = () => ctx.heartbeat(progress);
      beat();
      // Worker shutdown (a rolling deploy, a drained node), a heartbeat timeout (Temporal already
      // gave the turn to another attempt) or a pause is not a cancellation: let go of the turn so it
      // keeps running on the agent, and let the next attempt pick it up. Only a real cancellation
      // (someone pressed Stop, the run is gone) is passed to the agent.
      const cancel = new AbortController();
      const detach = new AbortController();
      const onCancelled = () => {
        const d = ctx.cancellationDetails;
        const handOver = Boolean(d?.workerShutdown || d?.timedOut || d?.paused) || ["WORKER_SHUTDOWN", "TIMED_OUT", "PAUSED"].includes((ctx.cancellationSignal.reason as Error | undefined)?.message ?? "");
        (handOver ? detach : cancel).abort(ctx.cancellationSignal.reason);
      };
      if (ctx.cancellationSignal.aborted) onCancelled();
      else ctx.cancellationSignal.addEventListener("abort", onCancelled, { once: true });
      const beatTimer = setInterval(beat, 10_000);
      let savedSession: string | null = known;

      // Steering: the API writes to `steering` and NOTIFYs; we inject into the live turn. Guidance
      // the agent cannot take (no steering support, or the turn is ending) is re-queued as the
      // next turn — atomically, through the delivery outbox — never dropped.
      let controller: TurnController | null = null;
      let steerChain: Promise<void> = Promise.resolve();
      const runRef = { id: p.runId, teamId: p.teamId, botId: p.botId, threadId: p.threadId, channel: thread.channel };
      const requeue = async (why: "unsupported" | "ended", ids?: number[]) => {
        const inbound = await withTx(db, (tx) => steering.requeue(tx, runRef, ids));
        if (!inbound.length) return;
        const what = inbound.length === 1 ? "your message will run" : `${inbound.length} messages will run`;
        sink.push({ type: "notice", severity: "info", title: why === "unsupported" ? `This agent can't take guidance mid-turn; ${what} as the next turn.` : `The turn ended before the guidance was applied; ${what} as the next turn.` });
        for (const m of inbound) {
          // Best effort now; the API's outbox relay retries if the workflow engine is unreachable.
          await deliverInbound(deps, m)
            .then(() => outbox.done(db, m.messageId, m.botId))
            .catch((err: unknown) => log.warn({ runId: p.runId, messageId: m.messageId, err: String(err) }, "re-queued guidance left to the outbox relay"));
        }
      };
      const handleSteering = () => {
        steerChain = steerChain
          .then(async () => {
            if (!controller) return;
            if (!controller.canSteer()) return requeue("unsupported");
            const failed: number[] = [];
            for (const s of await steering.takePending(db, p.runId)) if (!(await controller.steer(s.parts).catch(() => false))) failed.push(s.id);
            if (failed.length) await requeue("ended", failed);
          })
          .catch((err: unknown) => log.warn({ runId: p.runId, err: String(err) }, "steering failed"));
      };
      const unsubSteer = await listener.subscribe("orrery_steering", (runId) => {
        if (runId === p.runId) handleSteering();
      });
      // When the turn is over, guidance that is still pending becomes the next turn.
      const drainSteering = async () => {
        unsubSteer();
        await steerChain;
        await requeue("ended").catch((err: unknown) => log.warn({ runId: p.runId, err: String(err) }, "could not re-queue pending guidance"));
      };

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

        // Ask a human. A retried attempt gets held permission requests re-delivered by the
        // gateway: it continues with the approval already asked (or decided while no worker was
        // attached) instead of asking twice.
        const prior = await approvals.findForToolCall(db, p.runId, perm.toolCall.toolCallId);
        const reuse = prior && (prior.status === "pending" || prior.status === "approved" || prior.status === "denied") ? prior : null;
        const approvalId = reuse?.id ?? newId("approval");
        const expiresAt = reuse?.expiresAt ?? new Date(Date.now() + bot.policy.approvalTimeoutMinutes * 60_000).toISOString();
        const decided = new Promise<void>((resolve) => waiters.set(approvalId, resolve));
        if (!reuse) await approvals.create(db, {
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
        if (!reuse) await sink.pushNow({
          type: "approval.requested",
          approvalId,
          toolCall: perm.toolCall,
          options: perm.options,
          ...(perm.consent ? { consent: perm.consent } : {}),
          policy: { action: "ask", ...(final.matchedRule ? { matchedRule: final.matchedRule } : {}), ...(final.risk !== undefined ? { risk: final.risk } : {}), ...(final.reason ? { reason: final.reason } : {}) },
          expiresAt,
        });
        const timeout = new Promise<"timeout">((resolve) => {
          const t = setTimeout(() => resolve("timeout"), Math.max(0, Date.parse(expiresAt) - Date.now()));
          t.unref();
          signal.addEventListener("abort", () => clearTimeout(t), { once: true });
        });
        const aborted = new Promise<"aborted">((resolve) => signal.addEventListener("abort", () => resolve("aborted"), { once: true }));
        // The decision might have landed before we subscribed: check once.
        const pre = await approvals.getById(db, approvalId);
        const race = pre && pre.status !== "pending" ? "decided" : await Promise.race([decided.then(() => "decided" as const), timeout, aborted]);
        waiters.delete(approvalId);
        if (race === "aborted" && detach.signal.aborted) return { outcome: "cancelled" }; // never reaches the agent: the connection is closed
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
            detach: detach.signal,
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
              handleSteering(); // guidance that arrived before the session was ready
            },
            onProgress: (pr) => {
              progress = { ...pr, computerId: input.computer.computerId };
              if (pr.sessionId && pr.sessionId !== savedSession) {
                savedSession = pr.sessionId;
                void threads.setAcpSession(db, p.threadId, pr.sessionId, pr.agentEpoch, p.botId).catch(() => undefined);
              }
            },
            onElicitation: async (req) => {
              // Structured input requests are surfaced to the UI; v1 declines them in unattended runs.
              onEvent({ type: "elicitation.requested", elicitationId: String(req.elicitationId ?? newId("event")), message: req.message, mode: String(req.mode), ...(req.url ? { url: req.url } : {}), ...(req.requestedSchema ? { schema: req.requestedSchema } : {}) });
              return { action: "decline" };
            },
          },
          cancel.signal,
        );
        await drainSteering();
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
        if (err instanceof TurnDetachedError || detach.signal.aborted) {
          // Still running on the agent. Record where we are and hand it over; steering stays queued.
          beat();
          await sink.close();
          tracer.close("detached");
          log.info({ runId: p.runId, lastSeq: progress.lastSeq }, "worker shutting down; turn handed over");
          throw ApplicationFailure.create({ type: "worker_shutdown", message: "worker shutting down; the turn continues on another worker", nonRetryable: false });
        }
        const oe = isOrreryError(err) ? err : new OrreryError("provider_unavailable", err instanceof Error ? err.message : String(err), { cause: err });
        if (oe.code !== "interrupted") sink.push({ type: "turn.failed", error: { code: oe.code, message: oe.message, retryable: oe.retryable } });
        // A retryable failure resumes this same turn, which takes the pending guidance itself.
        if (!oe.retryable || oe.code === "interrupted") await drainSteering();
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
