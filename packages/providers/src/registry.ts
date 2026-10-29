import { OrreryError, type ProviderConfig } from "@orrery/core";
import { LlmDecisionClient, SystemOneClient, type DecisionClient } from "./decisions.js";
import { OpenAICompatibleClient } from "./openai.js";

export type OpenAIRole = "chat" | "fast" | "extract" | "summarize" | "embed" | "rerank";

/**
 * Resolves provider configs (ConfigMap) into clients. Kiro is not here: it is reached over ACP
 * through bot computers, not over HTTP.
 */
export class ProviderRegistry {
  private readonly openai = new Map<string, OpenAICompatibleClient>();
  private readonly clef = new Map<string, SystemOneClient>();
  private decisionClient: DecisionClient | null | undefined;

  constructor(
    readonly configs: ProviderConfig[],
    private readonly prefs: { embed?: string | undefined; fast?: string | undefined; clef?: string | undefined } = {},
    env: Record<string, string | undefined> = process.env,
  ) {
    for (const c of configs) {
      if (c.kind === "openai") this.openai.set(c.id, new OpenAICompatibleClient(c, env));
      else this.clef.set(c.id, new SystemOneClient(c, env));
    }
  }

  get(id: string): OpenAICompatibleClient {
    const c = this.openai.get(id);
    if (!c) throw new OrreryError("not_found", `unknown OpenAI-compatible provider ${id}`);
    return c;
  }

  has(id: string): boolean {
    return this.openai.has(id);
  }

  /** First provider serving a role (preferred id wins). */
  forRole(role: OpenAIRole): OpenAICompatibleClient | null {
    const preferred = role === "embed" ? this.prefs.embed : role === "fast" || role === "extract" || role === "summarize" ? this.prefs.fast : undefined;
    if (preferred && this.openai.has(preferred)) return this.openai.get(preferred)!;
    for (const c of this.openai.values()) if (c.config.roles.includes(role)) return c;
    return null;
  }

  requireRole(role: OpenAIRole): OpenAICompatibleClient {
    const c = this.forRole(role);
    if (!c) throw new OrreryError("provider_unavailable", `no provider configured for role "${role}"`);
    return c;
  }

  /** Default model for a role on its provider. */
  modelFor(role: OpenAIRole): { client: OpenAICompatibleClient; model: string } | null {
    const client = this.forRole(role);
    if (!client) return null;
    if (role === "embed") return client.config.models.embed ? { client, model: client.config.models.embed } : null;
    if (role === "rerank") return client.config.models.rerank ? { client, model: client.config.models.rerank } : null;
    const model = client.config.models.chat[0];
    return model ? { client, model } : null;
  }

  /** Clef if configured, else an LLM fallback on the fast model, else null. */
  decisions(): DecisionClient | null {
    if (this.decisionClient !== undefined) return this.decisionClient;
    const preferred = this.prefs.clef ? this.clef.get(this.prefs.clef) : undefined;
    const clef = preferred ?? this.clef.values().next().value;
    if (clef) this.decisionClient = clef;
    else {
      const fast = this.modelFor("fast") ?? this.modelFor("extract");
      this.decisionClient = fast ? new LlmDecisionClient(fast.client, fast.model) : null;
    }
    return this.decisionClient;
  }

  describe(): Array<{ id: string; kind: string; roles: string[]; models: unknown }> {
    return this.configs.map((c) => (c.kind === "openai" ? { id: c.id, kind: c.kind, roles: c.roles, models: c.models } : { id: c.id, kind: c.kind, roles: ["decide"], models: { model: c.model, fastModel: c.fastModel } }));
  }
}
