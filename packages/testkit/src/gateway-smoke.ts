/**
 * End-to-end smoke check against a running ACP gateway (a bot computer pod or a local one):
 * mints a gateway token, runs one turn through the real client stack (attach → session/new →
 * session/prompt with a permission round-trip) and prints a summary.
 *
 *   GATEWAY_TOKEN_SECRET=… node --conditions=@orrery/source --import tsx \
 *     packages/testkit/src/gateway-smoke.ts ws://host:7777/acp cmp_bot_ada [v3|v2] [prompt]
 */
import { foldTranscript, signToken, type AgentEvent } from "@orrery/core";
import { GATEWAY_TOKEN_AUDIENCE, KiroV2Adapter, KiroV3Adapter, connectWebSocket, runAcpTurn } from "@orrery/acp";

const [url, computerId, engine = "v3", prompt = "Say hello.\nrun: echo hi"] = process.argv.slice(2);
const secret = process.env.GATEWAY_TOKEN_SECRET;
if (!url || !computerId || !secret) {
  console.error("usage: GATEWAY_TOKEN_SECRET=… gateway-smoke.ts <ws-url> <computer-id> [v3|v2] [prompt]");
  process.exit(2);
}
const token = signToken({ sub: computerId, aud: GATEWAY_TOKEN_AUDIENCE, exp: Math.floor(Date.now() / 1000) + 600 }, secret);
const events: AgentEvent[] = [];
const started = Date.now();
const res = await runAcpTurn(
  { connect: () => connectWebSocket({ url, token }), adapter: engine === "v2" ? new KiroV2Adapter() : new KiroV3Adapter(), viaGateway: true },
  { requestKey: `smoke_${Date.now()}`, messageId: "smoke", session: { cwd: process.env.SMOKE_CWD ?? "/home/agent/workspace", mcpServers: [], binding: {} }, prompt: [{ type: "text", text: prompt }] },
  {
    onEvent: (e) => void events.push(e),
    decidePermission: async (p) => {
      const allow = p.options.find((o) => o.kind === "allow_once");
      return allow ? { outcome: "selected", optionId: allow.optionId } : { outcome: "cancelled" };
    },
    onProgress: () => undefined,
  },
  AbortSignal.timeout(Number(process.env.SMOKE_TIMEOUT_MS ?? 120_000)),
);
const t = foldTranscript(events);
console.log(
  JSON.stringify(
    { ok: res.stopReason === "end_turn", stopReason: res.stopReason, sessionId: res.sessionId, ms: Date.now() - started, text: t.assistantText.slice(0, 160), tools: t.tools.map((x) => `${x.kind}:${x.status}`), eventTypes: [...new Set(events.map((e) => e.type))] },
    null,
    2,
  ),
);
process.exit(res.stopReason === "end_turn" ? 0 : 1);
