import { describe, expect, it } from "vitest";
import { JsonRpcError, JsonRpcPeer, RPC_ERRORS, memoryTransportPair } from "../src/index.js";

function pair() {
  const [a, b] = memoryTransportPair();
  return { client: new JsonRpcPeer(a, { name: "client" }), agent: new JsonRpcPeer(b, { name: "agent" }) };
}

describe("JsonRpcPeer", () => {
  it("round-trips requests and preserves unknown fields", async () => {
    const { client, agent } = pair();
    agent.onRequest("echo", (p) => p);
    const res = await client.request("echo", { a: 1, _meta: { kiro: { replay: true }, vendor: { x: [1, 2] } } });
    expect(res).toEqual({ a: 1, _meta: { kiro: { replay: true }, vendor: { x: [1, 2] } } });
  });

  it("answers unknown agent→client requests with an explicit method-not-found error", async () => {
    const { client, agent } = pair();
    await expect(agent.request("_kiro/someFutureRequest", {})).rejects.toMatchObject({ code: RPC_ERRORS.methodNotFound });
    void client;
  });

  it("propagates JsonRpcError codes and data", async () => {
    const { client, agent } = pair();
    agent.onRequest("boom", () => {
      throw new JsonRpcError(-32002, "nope", { why: "test" });
    });
    await expect(client.request("boom")).rejects.toMatchObject({ code: -32002, message: "nope", data: { why: "test" } });
  });

  it("delivers notifications in order and ignores unhandled ones", async () => {
    const { client, agent } = pair();
    const seen: number[] = [];
    client.onNotification("tick", (p) => {
      seen.push((p as { n: number }).n);
    });
    for (let n = 0; n < 50; n++) agent.notify("tick", { n });
    agent.notify("unhandled/notification", {});
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });

  it("rejects pending requests when the connection closes", async () => {
    const { client, agent } = pair();
    agent.onRequest("slow", () => new Promise(() => undefined));
    const p = client.request("slow");
    agent.close("bye");
    await expect(p).rejects.toBeInstanceOf(JsonRpcError);
  });

  it("aborts the inbound handler signal on $/cancel_request", async () => {
    const { client, agent } = pair();
    let aborted = false;
    agent.onRequest("wait", (_p, ctx) => new Promise((_res, rej) => ctx.signal.addEventListener("abort", () => ((aborted = true), rej(new Error("x"))))));
    const ac = new AbortController();
    const p = client.request("wait", {}, { signal: ac.signal });
    setTimeout(() => ac.abort(), 5);
    await expect(p).rejects.toMatchObject({ code: RPC_ERRORS.requestCancelled });
    expect(aborted).toBe(true);
  });

  it("times out requests when configured", async () => {
    const { client, agent } = pair();
    agent.onRequest("never", () => new Promise(() => undefined));
    await expect(client.request("never", {}, { timeoutMs: 20 })).rejects.toThrow(/timed out/);
  });
});
