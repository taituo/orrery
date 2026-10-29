import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import Ajv2020Module from "ajv/dist/2020.js";

// ajv ships CJS with a default export; normalize for NodeNext ESM typing.
const Ajv2020 = ((Ajv2020Module as unknown as { default?: unknown }).default ?? Ajv2020Module) as unknown as new (opts: Record<string, unknown>) => {
  addSchema(s: unknown): void;
  getSchema(ref: string): (((v: unknown) => boolean) & { errors?: unknown[] | null }) | undefined;
};
import { KiroV3Adapter, memoryTransportPair, runAcpTurn, type JsonRpcMessage, type MessageTransport } from "@orrery/acp";
import { MockKiroAgent } from "../src/index.js";

/**
 * Wire conformance: every standard message Orrery's ACP client puts on the wire is validated
 * against the official ACP v1 JSON schema shipped with @agentclientprotocol/sdk.
 */
const require = createRequire(import.meta.url);
const schema = require("@agentclientprotocol/sdk/schema/v1/schema.unstable.json") as { $defs: Record<string, unknown> };

const METHOD_TO_DEF: Record<string, string> = {
  initialize: "InitializeRequest",
  "session/new": "NewSessionRequest",
  "session/load": "LoadSessionRequest",
  "session/prompt": "PromptRequest",
  "session/cancel": "CancelNotification",
  "session/set_mode": "SetSessionModeRequest",
  "session/set_config_option": "SetSessionConfigOptionRequest",
};

function recording(inner: MessageTransport, sink: JsonRpcMessage[]): MessageTransport {
  return {
    send: (m) => {
      sink.push(JSON.parse(JSON.stringify(m)) as JsonRpcMessage);
      inner.send(m);
    },
    onMessage: (h) => inner.onMessage(h),
    onClose: (h) => inner.onClose(h),
    close: (r) => inner.close(r),
    get isClosed() {
      return inner.isClosed;
    },
  };
}

describe("ACP schema conformance", () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  ajv.addSchema({ ...schema, $id: "acp" });
  const validate = (def: string, value: unknown) => {
    const v = ajv.getSchema(`acp#/$defs/${def}`);
    if (!v) throw new Error(`missing schema def ${def}`);
    const ok = v(value);
    return { ok, errors: v.errors };
  };

  it("client requests, notifications and permission responses match the official schema", async () => {
    const sent: JsonRpcMessage[] = [];
    const [client, server] = memoryTransportPair();
    new MockKiroAgent(server, { generation: "v3" });
    const ac = new AbortController();
    await runAcpTurn(
      { connect: async () => recording(client, sent), adapter: new KiroV3Adapter(), viaGateway: false },
      {
        requestKey: "r",
        messageId: "m",
        session: { cwd: "/workspace", mcpServers: [{ type: "http", name: "orrery", url: "http://api/mcp", headers: [{ name: "authorization", value: "Bearer x" }] }], binding: { modeId: "planner", modelId: "claude-sonnet", effort: "high" } },
        prompt: [{ type: "text", text: "run: npm test" }, { type: "resource_link", uri: "file:///workspace/README.md", name: "README.md" }],
      },
      {
        onEvent: () => undefined,
        decidePermission: async (p) => ({ outcome: "selected", optionId: p.options.find((o) => o.kind === "allow_always")!.optionId, persist: { scope: "workspace", resource: "npm *" } }),
      },
      ac.signal,
    );

    let checked = 0;
    for (const m of sent) {
      if ("method" in m && METHOD_TO_DEF[m.method]) {
        const r = validate(METHOD_TO_DEF[m.method]!, m.params);
        expect(r.errors ?? [], `${m.method}`).toEqual([]);
        checked++;
      } else if ("result" in m && m.result && typeof m.result === "object" && "outcome" in (m.result as object)) {
        const r = validate("RequestPermissionResponse", m.result);
        expect(r.errors ?? [], "permission response").toEqual([]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(4);
  });
});
