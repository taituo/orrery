import { PassThrough, Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import { NdjsonStreamTransport } from "@orrery/acp";

/**
 * A minimal standard ACP agent built with the *official* ACP TypeScript SDK. Used to prove that
 * Orrery's in-house client interoperates with the reference implementation (generic adapter,
 * session/update variants, permission round trip), independent of Kiro specifics.
 */
export function startSdkEchoAgent(): { clientTransport: NdjsonStreamTransport; close(): void } {
  const toAgent = new PassThrough();
  const toClient = new PassThrough();
  const stream = acp.ndJsonStream(Writable.toWeb(toClient) as WritableStream<Uint8Array>, Readable.toWeb(toAgent) as ReadableStream<Uint8Array>);

  const app = acp
    .agent({ name: "sdk-echo-agent" } as never)
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false } },
      agentInfo: { name: "sdk-echo-agent", version: "1.0.0" },
      authMethods: [],
    }))
    .onRequest(acp.methods.agent.session.new, () => ({ sessionId: `sess_${randomUUID()}` }))
    .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
      const text = params.prompt.map((b) => ("text" in b ? b.text : "")).join("");
      await client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: "tool_call", toolCallId: "call-1", title: "Echo tool", kind: "other", status: "pending" },
      });
      const perm = await client.request(acp.methods.client.session.requestPermission, {
        sessionId: params.sessionId,
        toolCall: { toolCallId: "call-1", title: "Echo tool", kind: "other", status: "pending" },
        options: [
          { optionId: "yes", name: "Allow", kind: "allow_once" },
          { optionId: "no", name: "Deny", kind: "reject_once" },
        ],
      });
      const allowed = perm.outcome.outcome === "selected" && perm.outcome.optionId === "yes";
      await client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: allowed ? "completed" : "failed" },
      });
      await client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `echo: ${text}` } },
      });
      return { stopReason: "end_turn" as const, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    })
    .onNotification(acp.methods.agent.session.cancel, () => undefined);

  const conn = app.connect(stream);
  const clientTransport = new NdjsonStreamTransport(toClient, toAgent);
  return {
    clientTransport,
    close: () => {
      clientTransport.close();
      void (conn as { close?: () => unknown }).close?.();
    },
  };
}
