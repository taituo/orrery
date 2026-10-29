import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type { InboundMessage } from "@orrery/core";
import {
  approvalDecisionSignal,
  botStateQuery,
  botWorkflow,
  inboundSignal,
  turnWorkflow,
  workflowIds,
  type AcpActivities,
  type AgentActivities,
  type MemoryActivities,
  type PreparedTurn,
} from "@orrery/workflows";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import { bundleWorkflows } from "../src/workflow-bundle.js";

function findOnPath(bin: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const p = path.join(dir, bin);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  return undefined;
}

/**
 * End-to-end workflow tests against Temporal's local dev server with mocked activities.
 * Uses TEMPORAL_CLI_PATH (or a `temporal` binary on PATH) when present, otherwise the SDK
 * downloads the dev server. TEMPORAL_TEST=0 skips; TEMPORAL_TEST=1 makes a failed start fatal.
 */
let env: TestWorkflowEnvironment | null = null;
let skipReason = "";

beforeAll(async () => {
  try {
    const cli = process.env.TEMPORAL_CLI_PATH ?? findOnPath("temporal");
    env = await TestWorkflowEnvironment.createLocal(cli ? { server: { executable: { type: "existing-path", path: cli } } } : undefined);
  } catch (err) {
    skipReason = err instanceof Error ? err.message : String(err);
    if (process.env.TEMPORAL_TEST === "1") throw err;
  }
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

const prefix = "test";
const queues = { agent: `${prefix}-agent`, acp: `${prefix}-acp`, memory: `${prefix}-memory` };

function prepared(runId: string, threadId: string, kind: "kiro-acp" | "openai"): PreparedTurn {
  return {
    runId,
    teamId: "team_1",
    botId: "bot_1",
    threadId,
    botName: "Ada",
    target: "primary",
    binding: kind === "openai" ? { kind: "openai", providerId: "p", model: "m", maxSteps: 4 } : { kind: "kiro-acp", engine: "v3", authMethod: "cli" },
    assistantMessageId: runId.replace("run_", "msg_"),
    inputParts: [{ type: "text", text: "hi" }],
    maxSteps: kind === "openai" ? 4 : 1,
    approvalTimeoutMinutes: 1,
    replyTo: null,
    authorUserId: "usr_1",
  };
}

function inbound(id: string, threadId: string): InboundMessage {
  return { messageId: id, threadId, botId: "bot_1", teamId: "team_1", channel: "web", author: { type: "user", id: "usr_1" }, parts: [{ type: "text", text: id }], replyTo: null, receivedAt: new Date().toISOString() };
}

describe.skipIf(process.env.TEMPORAL_TEST === "0")("Temporal workflows", () => {
  it("bot workflow runs ACP turns per thread, coalesces messages, finalizes", async (ctx) => {
    if (!env) return ctx.skip();
    const finalized: string[] = [];
    const turnsSeen: string[][] = [];
    const agent: Partial<AgentActivities> = {
      prepareTurn: async (t) => {
        turnsSeen.push(t.messages.map((m) => m.messageId));
        return prepared(t.runId, t.threadId, "kiro-acp");
      },
      ensureComputer: async () => ({ computerId: "cmp_1", endpoint: "ws://x", agentKind: "kiro-v3", cwd: "/w" }),
      finalizeTurn: async (f) => {
        finalized.push(`${f.prepared.threadId}:${f.status}`);
        return { episodeId: null, needsConsolidation: false };
      },
    };
    const acp: AcpActivities = {
      runAcpTurn: async () => {
        await new Promise((r) => setTimeout(r, 300));
        return { stopReason: "end_turn", usage: { metering: { credits: 0.1 } }, model: "claude-sonnet", sessionId: "s1", agentEpoch: "e1" };
      },
    };
    const bundle = await bundleWorkflows();
    const agentWorker = await Worker.create({ connection: env.nativeConnection, taskQueue: queues.agent, workflowBundle: bundle, activities: agent });
    const acpWorker = await Worker.create({ connection: env.nativeConnection, taskQueue: queues.acp, activities: acp });
    await Promise.all([
      agentWorker.runUntil(
        acpWorker.runUntil(async () => {
          const handle = await env!.client.workflow.signalWithStart(botWorkflow, {
            workflowId: workflowIds.bot("bot_1"),
            taskQueue: queues.agent,
            args: [{ botId: "bot_1", teamId: "team_1" }],
            signal: inboundSignal,
            signalArgs: [inbound("m1", "t1")],
          });
          await new Promise((r) => setTimeout(r, 100));
          await handle.signal(inboundSignal, inbound("m2", "t1")); // arrives while t1 is busy → coalesced
          await handle.signal(inboundSignal, inbound("m3", "t1"));
          await handle.signal(inboundSignal, inbound("m4", "t2")); // other thread runs concurrently
          for (let i = 0; i < 100 && finalized.length < 3; i++) await new Promise((r) => setTimeout(r, 100));
          const state = await handle.query(botStateQuery);
          expect(state.queued).toBe(0);
          await handle.terminate();
        }),
      ),
    ]);
    expect(turnsSeen).toContainEqual(["m1"]);
    expect(turnsSeen).toContainEqual(["m2", "m3"]);
    expect(turnsSeen).toContainEqual(["m4"]);
    expect(finalized.filter((f) => f.endsWith(":completed"))).toHaveLength(3);
  }, 120_000);

  it("native loop waits durably for a human approval signal", async (ctx) => {
    if (!env) return ctx.skip();
    const executed: string[] = [];
    let step = 0;
    const agent: Partial<AgentActivities> = {
      prepareTurn: async (t) => prepared(t.runId, t.threadId, "openai"),
      llmStep: async () => {
        step++;
        return step === 1
          ? { text: "", toolCalls: [{ id: "c1", name: "mcp__gh__merge", arguments: "{}" }], finishReason: "tool_calls", usage: { inputTokens: 10 }, model: "m" }
          : { text: "done", toolCalls: [], finishReason: "stop", usage: { inputTokens: 5 }, model: "m" };
      },
      evaluateToolCall: async ({ toolCall }) => ({ toolCallId: toolCall.id, effect: "ask", risk: 0.7, reason: "guardrail", title: toolCall.name, kind: "edit", capability: "mcp", resource: "gh/merge" }),
      openApproval: async () => ({ expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      closeApproval: async () => undefined,
      executeTool: async ({ toolCall }) => {
        executed.push(toolCall.id);
        return { ok: true, output: "merged" };
      },
      recordToolDenied: async () => undefined,
      finalizeTurn: async () => ({ episodeId: null, needsConsolidation: false }),
    };
    const memory: Partial<MemoryActivities> = {};
    const bundle = await bundleWorkflows();
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: queues.agent, workflowBundle: bundle, activities: { ...agent, ...memory } });
    const outcome = await worker.runUntil(async () => {
      const h = await env!.client.workflow.start(turnWorkflow, {
        workflowId: workflowIds.turn("run_native"),
        taskQueue: queues.agent,
        args: [{ runId: "run_native", teamId: "team_1", botId: "bot_1", threadId: "t9", messages: [inbound("m9", "t9")] }],
      });
      await new Promise((r) => setTimeout(r, 1000));
      expect(executed).toEqual([]); // still waiting for the human
      await h.signal(approvalDecisionSignal, { approvalId: "apr_c1_run_native", optionId: "allow", optionKind: "allow_once", cancelled: false, actor: "usr_1" });
      return h.result();
    });
    expect(executed).toEqual(["c1"]);
    expect(outcome.stopReason).toBe("end_turn");
    expect(outcome.usage.inputTokens).toBe(15);
  }, 120_000);
});

void skipReason;
