import type { ProviderConfig } from "@orrery/core";

/** OpenCode sees each exposed Orrery provider as `orrery-<id>`; models are `orrery-<id>/<model>`. */
export const OPENCODE_PROVIDER_PREFIX = "orrery-";

export interface OpenCodeProvider {
  id: string;
  name?: string;
  baseUrl: string;
  apiKeyEnv?: string;
  headers: Record<string, string>;
  models: string[];
  tools: boolean;
  vision: boolean;
}

/** OpenAI-compatible providers serving chat models are offered to OpenCode bots. */
export function openCodeProviders(configs: readonly ProviderConfig[]): OpenCodeProvider[] {
  return configs.flatMap((c) =>
    c.kind === "openai" && (c.roles.includes("chat") || c.roles.includes("fast")) && c.models.chat.length
      ? [{ id: c.id, ...(c.name ? { name: c.name } : {}), baseUrl: c.baseUrl, ...(c.apiKeyEnv ? { apiKeyEnv: c.apiKeyEnv } : {}), headers: c.headers, models: c.models.chat, tools: c.capabilities.tools, vision: c.capabilities.vision }]
      : [],
  );
}

/** `orrery-<id>/<model>` ids an OpenCode bot can pick from Orrery's own providers. */
export function openCodeModelIds(configs: readonly ProviderConfig[]): string[] {
  return openCodeProviders(configs).flatMap((p) => p.models.map((m) => `${OPENCODE_PROVIDER_PREFIX}${p.id}/${m}`));
}

/**
 * Validates a model id for an OpenCode bot. Ids naming an Orrery provider must exist; other
 * ids (`anthropic/…`, `openai/…`, providers from the bot's own config) are OpenCode's to check.
 */
export function openCodeModelProblem(model: string, configs: readonly ProviderConfig[]): string | null {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return `model "${model}" must look like provider/model`;
  const provider = model.slice(0, slash);
  if (!provider.startsWith(OPENCODE_PROVIDER_PREFIX)) return null;
  const exposed = openCodeProviders(configs).find((p) => `${OPENCODE_PROVIDER_PREFIX}${p.id}` === provider);
  if (!exposed) return `"${provider}" is not an Orrery chat provider (available: ${openCodeProviders(configs).map((p) => OPENCODE_PROVIDER_PREFIX + p.id).join(", ") || "none"})`;
  if (!exposed.models.includes(model.slice(slash + 1))) return `provider "${provider}" has no chat model "${model.slice(slash + 1)}" (models: ${exposed.models.join(", ")})`;
  return null;
}
