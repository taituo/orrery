import { partsToText, truncate, type ContentPart, type RoutingSettings, type ToolRequestFacts } from "@orrery/core";
import { q, type DecisionClient } from "./decisions.js";

export interface RouteDecision {
  target: "primary" | "fast";
  reason: string;
  scores?: Record<string, number>;
}

/**
 * Per-message routing between the bot's primary agent (Kiro over ACP: tools, computer, long
 * horizon) and a fast OpenAI-compatible model (chit-chat, quick answers). Clef decides in tens
 * of milliseconds; any failure routes to the primary (never silently degrade capability).
 */
export async function decideRoute(
  decisions: DecisionClient | null,
  routing: RoutingSettings,
  input: { parts: ContentPart[]; channel: string; recentContext?: string; forced?: "primary" | "fast" | null },
): Promise<RouteDecision> {
  if (input.forced) return { target: input.forced, reason: "forced by caller" };
  if (routing.mode === "fixed" || !routing.fast) return { target: "primary", reason: "fixed routing" };
  if (input.parts.some((p) => p.type !== "text")) return { target: "primary", reason: "attachments need the agent" };
  if (!decisions) return { target: "primary", reason: "no decision model configured" };
  const text = partsToText(input.parts);
  try {
    const a = await decisions.decide(
      { message: truncate(text, 4000), channel: input.channel, recent: truncate(input.recentContext ?? "", 2000) },
      {
        needsAgent: q.noul(
          "Does answering this message require taking actions or using tools: running commands, reading or editing files or repositories, browsing, calling external services, multi-step work, or anything stateful?",
        ),
        kind: q.choice("What kind of message is this?", {
          chat: "Greeting, small talk, a quick factual question, or a short rewrite that needs no tools",
          agent: "A task to perform, investigate, build, fix, research or change something",
          followup: "A follow-up about ongoing work in this conversation",
        }),
      },
      { fast: true },
    );
    const p = a.needsAgent.noul;
    const scores = { needsAgent: p, ...Object.fromEntries(Object.entries(a.kind.probabilities).map(([k, v]) => [`kind.${k}`, v])) };
    if (a.kind.choice === "followup") return { target: "primary", reason: "follow-up to ongoing work", scores };
    if (p < routing.agentThreshold && a.kind.choice === "chat") return { target: "fast", reason: `needs-agent ${p.toFixed(2)} < ${routing.agentThreshold}`, scores };
    return { target: "primary", reason: `needs-agent ${p.toFixed(2)}`, scores };
  } catch (err) {
    return { target: "primary", reason: `routing failed open: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Guardrail risk for a tool call. Returns the probability the action is dangerous, or null if the
 * decision model is unavailable (the policy result then stands unchanged — guardrails can only
 * tighten decisions, never loosen them).
 */
export async function assessToolRisk(
  decisions: DecisionClient | null,
  facts: ToolRequestFacts,
  detail: { title: string; rawInput?: unknown; botInstructions?: string },
  signal?: AbortSignal,
): Promise<number | null> {
  if (!decisions) return null;
  try {
    const a = await decisions.decide(
      {
        capability: facts.capability,
        resource: truncate(facts.resource, 2000),
        tool: facts.tool ?? null,
        server: facts.mcpServer ?? null,
        title: truncate(detail.title, 300),
        input: truncate(JSON.stringify(detail.rawInput ?? null), 3000),
        botPurpose: truncate(detail.botInstructions ?? "", 1000),
      },
      {
        risky: q.noul(
          "Is executing this action risky: destructive or irreversible, deleting or overwriting data, escalating privileges, exfiltrating secrets or private data to an external destination, spending money, or contacting people outside the organization?",
          { true: "the action could cause damage or data loss or leak", false: "routine, reversible, read-only or local" },
        ),
      },
      { fast: true, ...(signal ? { signal } : {}) },
    );
    return a.risky.noul;
  } catch {
    return null;
  }
}
