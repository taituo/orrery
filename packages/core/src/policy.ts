import type { PolicyEffect, PolicyRule, ToolPolicy } from "./domain.js";
import type { ToolKind } from "./events.js";

/**
 * Deterministic, dependency-free tool policy evaluation. Mirrors Kiro's own precedence
 * (deny overrides ask, ask overrides allow) so the two layers compose predictably:
 *
 *   Kiro harness policy  ──(asks via session/request_permission)──▶  Orrery policy
 *                                                                    ├─ allow → answer allow_once
 *                                                                    ├─ deny  → answer reject_once
 *                                                                    └─ ask   → human approval
 *
 * Safe to import from Temporal workflow code (no I/O, no randomness, no clocks).
 */

export interface ToolRequestFacts {
  /** Capability as declared by the agent (Kiro V3 consent.capability) or derived from kind. */
  capability: string;
  kind: ToolKind;
  /** The concrete resource: command line, path, URL or `server/tool`. */
  resource: string;
  mcpServer?: string;
  tool?: string;
}

export interface PolicyVerdict {
  effect: PolicyEffect;
  matchedRule?: string;
  reason?: string;
}

const KIND_TO_CAPABILITY: Record<ToolKind, string> = {
  read: "read",
  edit: "write",
  delete: "delete",
  move: "move",
  search: "search",
  execute: "shell",
  think: "think",
  fetch: "fetch",
  switch_mode: "mode",
  other: "other",
};

export function capabilityForKind(kind: ToolKind): string {
  return KIND_TO_CAPABILITY[kind];
}

const globCache = new Map<string, RegExp>();

const PATH_CAPABILITIES = new Set(["read", "write", "edit", "delete", "move"]);

/**
 * Glob → RegExp. `**` matches anything. In path mode `*` stays within one path segment and `?`
 * matches one non-separator char; for commands/URLs/tool names (`pathMode: false`) `*` matches
 * anything, so `npm run *` covers `npm run test -- src/a.ts`.
 */
export function globToRegExp(glob: string, pathMode = true): RegExp {
  const key = (pathMode ? "p:" : "c:") + glob;
  const cached = globCache.get(key);
  if (cached) return cached;
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += pathMode ? "[^/]*" : ".*";
      }
    } else if (c === "?") {
      re += pathMode ? "[^/]" : ".";
    } else if (c === "{") {
      const close = glob.indexOf("}", i);
      if (close > i) {
        const alts = glob.slice(i + 1, close).split(",").map((a) => a.replace(/[\\^$+.()|[\]*?]/g, "\\$&"));
        re += `(?:${alts.join("|")})`;
        i = close;
      } else re += "\\{";
    } else if ("\\^$+.()|{}[]".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  re += "$";
  const compiled = new RegExp(re, "s");
  if (globCache.size > 2000) globCache.clear();
  globCache.set(key, compiled);
  return compiled;
}

export function globMatch(glob: string, value: string, pathMode = true): boolean {
  if (glob === "**") return true;
  return globToRegExp(glob, pathMode).test(value);
}

export function isPathCapability(capability: string): boolean {
  return PATH_CAPABILITIES.has(capability);
}

function ruleMatches(rule: PolicyRule, f: ToolRequestFacts): boolean {
  if (rule.capability !== "*" && rule.capability !== f.capability) {
    // allow rules written against the kind name too ("execute" vs "shell")
    if (rule.capability !== f.kind) return false;
  }
  if (rule.mcpServer && rule.mcpServer !== f.mcpServer) return false;
  if (rule.tool && rule.tool !== f.tool) return false;
  return globMatch(rule.resource, f.resource, isPathCapability(f.capability));
}

const RANK: Record<PolicyEffect, number> = { allow: 0, ask: 1, deny: 2 };

export function evaluatePolicy(policy: Pick<ToolPolicy, "defaultEffect" | "rules">, facts: ToolRequestFacts): PolicyVerdict {
  let best: PolicyVerdict | null = null;
  for (const rule of policy.rules) {
    if (!ruleMatches(rule, facts)) continue;
    if (!best || RANK[rule.effect] > RANK[best.effect]) {
      best = { effect: rule.effect, matchedRule: rule.id, ...(rule.reason ? { reason: rule.reason } : {}) };
      if (rule.effect === "deny") break;
    }
  }
  return best ?? { effect: policy.defaultEffect, reason: "default" };
}

/**
 * Combine a policy verdict with a guardrail risk probability. Guardrails can only make a
 * decision stricter, never looser (an explicit deny is never relaxed, an ask never becomes allow).
 */
export function applyGuardrail(
  verdict: PolicyVerdict,
  risk: number | null | undefined,
  guardrail: { enabled: boolean; askAbove: number; denyAbove: number },
): PolicyVerdict & { risk?: number } {
  if (!guardrail.enabled || risk === null || risk === undefined || Number.isNaN(risk)) return verdict;
  if (risk >= guardrail.denyAbove && verdict.effect !== "deny") {
    return { effect: "deny", reason: `guardrail risk ${risk.toFixed(2)} ≥ ${guardrail.denyAbove}`, risk };
  }
  if (risk >= guardrail.askAbove && verdict.effect === "allow") {
    return { effect: "ask", reason: `guardrail risk ${risk.toFixed(2)} ≥ ${guardrail.askAbove}`, risk };
  }
  return { ...verdict, risk };
}

/** Sensible starter policy for new bots: reads free, shell/network/writes need a human. */
export function defaultPolicyRules(): PolicyRule[] {
  return [
    { id: "read-free", effect: "allow", capability: "read", resource: "**" },
    { id: "search-free", effect: "allow", capability: "search", resource: "**" },
    { id: "think-free", effect: "allow", capability: "think", resource: "**" },
    // Orrery platform tools (native loop: capability "platform"; via Kiro MCP: capability "mcp")
    { id: "platform-read", effect: "allow", capability: "platform", resource: "orrery/{memory_search,knowledge_search,bots_list,conversation_history}" },
    { id: "platform-memory", effect: "allow", capability: "platform", resource: "orrery/{memory_save,core_memory_append}" },
    { id: "mcp-orrery-read", effect: "allow", capability: "mcp", resource: "orrery/{memory_search,knowledge_search,bots_list,conversation_history}" },
    { id: "mcp-orrery-memory", effect: "allow", capability: "mcp", resource: "orrery/{memory_save,core_memory_append}" },
    { id: "safe-git-read", effect: "allow", capability: "shell", resource: "git status*" },
    { id: "safe-ls", effect: "allow", capability: "shell", resource: "ls*" },
    { id: "no-rm-rf", effect: "deny", capability: "shell", resource: "**rm -rf /**", reason: "destructive" },
    { id: "no-secrets-read", effect: "deny", capability: "read", resource: "**/.ssh/**", reason: "secrets" },
  ];
}
