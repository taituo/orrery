import { ScheduleOverlapPolicy, WorkflowNotFoundError, type Client, type ScheduleSpec } from "@temporalio/client";
import type { Duration } from "@temporalio/common";
import type { Bot, InboundMessage, Routine } from "@orrery/core";
import {
  approvalDecisionSignal,
  botStateQuery,
  botWorkflow,
  consolidateMemoryWorkflow,
  inboundSignal,
  ingestSourceWorkflow,
  routineWorkflow,
  setPausedSignal,
  turnProgressQuery,
  workflowIds,
  type ApprovalDecisionSignal,
  type BotState,
} from "@orrery/workflows";

/**
 * Everything the API asks of Temporal, behind an interface so routes are testable without a
 * Temporal server.
 */
export interface WorkflowGateway {
  deliver(message: InboundMessage): Promise<void>;
  cancelRun(runId: string): Promise<boolean>;
  signalApproval(runId: string, decision: ApprovalDecisionSignal): Promise<void>;
  setPaused(botId: string, teamId: string, paused: boolean): Promise<void>;
  botState(botId: string): Promise<BotState | null>;
  runProgress(runId: string): Promise<{ phase: string; step: number; pendingApprovals: string[] } | null>;
  upsertRoutine(routine: Routine): Promise<void>;
  deleteRoutine(routineId: string): Promise<void>;
  triggerRoutine(routineId: string): Promise<void>;
  startIngest(sourceId: string): Promise<void>;
  ensureBotSchedules(bot: Bot): Promise<void>;
  consolidateNow(teamId: string, botId: string): Promise<void>;
}

export class TemporalWorkflowGateway implements WorkflowGateway {
  constructor(private readonly client: Client, private readonly queues: { agent: string }) {}

  async deliver(message: InboundMessage): Promise<void> {
    await this.client.workflow.signalWithStart(botWorkflow, {
      workflowId: workflowIds.bot(message.botId),
      taskQueue: this.queues.agent,
      args: [{ botId: message.botId, teamId: message.teamId }],
      signal: inboundSignal,
      signalArgs: [message],
    });
  }

  async cancelRun(runId: string): Promise<boolean> {
    try {
      await this.client.workflow.getHandle(workflowIds.turn(runId)).cancel();
      return true;
    } catch (err) {
      if (err instanceof WorkflowNotFoundError) return false;
      throw err;
    }
  }

  async signalApproval(runId: string, decision: ApprovalDecisionSignal): Promise<void> {
    try {
      await this.client.workflow.getHandle(workflowIds.turn(runId)).signal(approvalDecisionSignal, decision);
    } catch (err) {
      if (!(err instanceof WorkflowNotFoundError)) throw err;
    }
  }

  async setPaused(botId: string, teamId: string, paused: boolean): Promise<void> {
    await this.client.workflow.signalWithStart(botWorkflow, {
      workflowId: workflowIds.bot(botId),
      taskQueue: this.queues.agent,
      args: [{ botId, teamId }],
      signal: setPausedSignal,
      signalArgs: [paused],
    });
  }

  async botState(botId: string): Promise<BotState | null> {
    try {
      return await this.client.workflow.getHandle(workflowIds.bot(botId)).query(botStateQuery);
    } catch {
      return null;
    }
  }

  async runProgress(runId: string) {
    try {
      return await this.client.workflow.getHandle(workflowIds.turn(runId)).query(turnProgressQuery);
    } catch {
      return null;
    }
  }

  async upsertRoutine(r: Routine): Promise<void> {
    const scheduleId = workflowIds.routineSchedule(r.id);
    const spec: ScheduleSpec = r.schedule.cron
      ? { cronExpressions: [r.schedule.cron], timezone: r.schedule.timezone }
      : { intervals: [{ every: `${r.schedule.intervalMinutes ?? 60} minutes` as Duration }], timezone: r.schedule.timezone };
    const action = { type: "startWorkflow" as const, workflowType: routineWorkflow, taskQueue: this.queues.agent, args: [{ routineId: r.id }] as [{ routineId: string }] };
    const handle = this.client.schedule.getHandle(scheduleId);
    try {
      await handle.update((prev) => ({ ...prev, spec, action, state: { ...prev.state, paused: !r.enabled } }));
    } catch {
      await this.client.schedule.create({ scheduleId, spec, action, policies: { overlap: ScheduleOverlapPolicy.SKIP, catchupWindow: "1 hour" }, state: { paused: !r.enabled } });
    }
  }

  async deleteRoutine(routineId: string): Promise<void> {
    await this.client.schedule.getHandle(workflowIds.routineSchedule(routineId)).delete().catch(() => undefined);
  }

  async triggerRoutine(routineId: string): Promise<void> {
    await this.client.schedule.getHandle(workflowIds.routineSchedule(routineId)).trigger(ScheduleOverlapPolicy.ALLOW_ALL);
  }

  async startIngest(sourceId: string): Promise<void> {
    await this.client.workflow.start(ingestSourceWorkflow, {
      workflowId: workflowIds.ingest(sourceId),
      taskQueue: this.queues.agent,
      args: [{ sourceId }],
      workflowIdConflictPolicy: "USE_EXISTING",
    });
  }

  async ensureBotSchedules(bot: Bot): Promise<void> {
    try {
      await this.client.schedule.create({
        scheduleId: workflowIds.consolidateSchedule(bot.id),
        spec: { cronExpressions: ["17 3 * * *"] },
        action: { type: "startWorkflow", workflowType: consolidateMemoryWorkflow, taskQueue: this.queues.agent, args: [{ teamId: bot.teamId, botId: bot.id }], workflowId: workflowIds.consolidate(bot.id) },
        policies: { overlap: ScheduleOverlapPolicy.SKIP },
      });
    } catch (err) {
      if (!String(err).toLowerCase().includes("already")) throw err;
    }
  }

  async consolidateNow(teamId: string, botId: string): Promise<void> {
    await this.client.workflow.start(consolidateMemoryWorkflow, {
      workflowId: workflowIds.consolidate(botId),
      taskQueue: this.queues.agent,
      args: [{ teamId, botId }],
      workflowIdConflictPolicy: "USE_EXISTING",
    });
  }
}

/** In-memory implementation for tests and the offline prototype. */
export class RecordingWorkflowGateway implements WorkflowGateway {
  readonly calls: Array<{ op: string; args: unknown[] }> = [];
  private rec(op: string, ...args: unknown[]) {
    this.calls.push({ op, args });
  }
  async deliver(m: InboundMessage) {
    this.rec("deliver", m);
  }
  async cancelRun(runId: string) {
    this.rec("cancelRun", runId);
    return true;
  }
  async signalApproval(runId: string, d: ApprovalDecisionSignal) {
    this.rec("signalApproval", runId, d);
  }
  async setPaused(botId: string, teamId: string, paused: boolean) {
    this.rec("setPaused", botId, teamId, paused);
  }
  async botState(botId: string) {
    return { botId, paused: false, queued: 0, running: {} };
  }
  async runProgress() {
    return null;
  }
  async upsertRoutine(r: Routine) {
    this.rec("upsertRoutine", r.id);
  }
  async deleteRoutine(id: string) {
    this.rec("deleteRoutine", id);
  }
  async triggerRoutine(id: string) {
    this.rec("triggerRoutine", id);
  }
  async startIngest(id: string) {
    this.rec("startIngest", id);
  }
  async ensureBotSchedules(b: Bot) {
    this.rec("ensureBotSchedules", b.id);
  }
  async consolidateNow(teamId: string, botId: string) {
    this.rec("consolidateNow", teamId, botId);
  }
}
