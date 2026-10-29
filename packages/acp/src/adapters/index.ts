import type { ProviderBinding } from "@orrery/core";
import type { InitializeResponse } from "../protocol.js";
import { getPath } from "../protocol.js";
import { StandardAcpAdapter } from "./base.js";
import { KiroV2Adapter } from "./kiro-v2.js";
import { KiroV3Adapter } from "./kiro-v3.js";
import type { AgentAdapter } from "./types.js";

export * from "./types.js";
export { StandardAcpAdapter, normalizeOptions, resourceFromRawInput, flattenValues } from "./base.js";
export { KiroV3Adapter, parseMcpSnapshot, pickAnnotations } from "./kiro-v3.js";
export { KiroV2Adapter } from "./kiro-v2.js";

export interface AdapterFactoryOptions {
  kiroAccessToken?: () => Promise<unknown>;
}

/** Adapter for a binding. `auto` picks V3 or v2 from the live initialize result. */
export function createAdapter(binding: ProviderBinding, opts: AdapterFactoryOptions = {}): AgentAdapter {
  if (binding.kind === "acp") return new StandardAcpAdapter();
  if (binding.kind !== "kiro-acp") throw new Error(`no ACP adapter for provider kind ${binding.kind}`);
  if (binding.engine === "v2") return new KiroV2Adapter();
  if (binding.engine === "auto") return autoKiroAdapter(opts);
  return new KiroV3Adapter(opts.kiroAccessToken ? { accessToken: opts.kiroAccessToken } : {});
}

/**
 * Engine-agnostic Kiro adapter: delegates to V3 or v2 once `initialize` reveals which server
 * generation is running (the gateway may have fallen back to a v2 binary).
 */
export function autoKiroAdapter(opts: AdapterFactoryOptions = {}): AgentAdapter {
  let impl: AgentAdapter = new KiroV3Adapter(opts.kiroAccessToken ? { accessToken: opts.kiroAccessToken } : {});
  const handler: ProxyHandler<AgentAdapter> = {
    get(_t, prop) {
      if (prop === "onInitialized") {
        return (init: InitializeResponse) => {
          if (detectKiroEngine(init) === "v2") impl = new KiroV2Adapter();
          impl.onInitialized(init);
        };
      }
      const v = (impl as unknown as Record<string | symbol, unknown>)[prop];
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(impl) : v;
    },
  };
  return new Proxy(impl, handler);
}

/**
 * Identify the server generation from a live initialize result. The ACP protocol version can't
 * be used (both generations negotiate 1). V3 advertises Kiro extensions through
 * `agentCapabilities._meta.kiro`; v2 has a fixed catalog and no such advertisement.
 */
export function detectKiroEngine(init: InitializeResponse): "v3" | "v2" | "unknown" {
  const name = String(init.agentInfo?.name ?? "").toLowerCase();
  const isKiro = name.includes("kiro");
  if (getPath(init, ["agentCapabilities", "_meta", "kiro"]) !== undefined) return "v3";
  if (isKiro) return "v2";
  return "unknown";
}

/** Launch error output that indicates the binary does not know the V3 engine flag. */
export function looksLikeUnsupportedV3Flag(stderr: string): boolean {
  return /agent-engine|unexpected argument|unknown (option|flag|argument)|unrecognized/i.test(stderr);
}
