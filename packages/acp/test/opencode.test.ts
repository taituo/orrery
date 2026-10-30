import { describe, expect, it } from "vitest";
import { evaluatePolicy, defaultPolicyRules, type ToolPolicy } from "@orrery/core";
import {
  OPENCODE_TOOL_AGENTS,
  OpenCodeAdapter,
  classifyAgentFailure,
  createAdapter,
  gatewayKeyFor,
  isPermanentAgentFailure,
  openCodeConfig,
  openCodeEnvironment,
  type RequestPermissionRequest,
  type SessionNotification,
} from "../src/index.js";

/* Wire shapes below were captured from opencode 1.19.5 (`opencode acp`). */

const options = [
  { optionId: "once", kind: "allow_once" as const, name: "Allow once" },
  { optionId: "always", kind: "allow_always" as const, name: "Always allow" },
  { optionId: "reject", kind: "reject_once" as const, name: "Reject" },
];
const update = (u: Record<string, unknown>): SessionNotification => ({ sessionId: "ses_1", update: u as never });
const ctx = { messageId: "msg_1" };

describe("OpenCode adapter", () => {
  it("launches `opencode acp` in the workspace", () => {
    const spec = new OpenCodeAdapter().launch({ binary: "opencode", binding: {}, cwd: "/home/agent/workspace", env: { OPENCODE_CONFIG_CONTENT: "{}" } });
    expect(spec.command).toBe("opencode");
    expect(spec.args).toEqual(["acp", "--cwd", "/home/agent/workspace"]);
    expect(spec.env).toEqual({ OPENCODE_CONFIG_CONTENT: "{}" });
    expect(new OpenCodeAdapter({ pure: true }).launch({ binary: "opencode", binding: {} }).args).toEqual(["acp", "--pure"]);
  });

  it("is created for opencode-acp bindings and reports what OpenCode supports", () => {
    const a = createAdapter({ kind: "opencode-acp", permissions: "orrery" });
    expect(a).toBeInstanceOf(OpenCodeAdapter);
    expect(a.supports("steer")).toBe(false);
    expect(a.supports("compact")).toBe(false);
    expect(a.supports("setModel")).toBe(true);
    expect(a.supports("setMode")).toBe(true);
    expect(a.supports("setEffort")).toBe(false);
  });

  it("fills an empty permission rawInput from the tool call it has seen, so policies match the real path", () => {
    const a = new OpenCodeAdapter();
    // Placeholder first (title = tool name, no input), then the real input.
    a.normalizeUpdate(update({ sessionUpdate: "tool_call", toolCallId: "call_1", title: "read", kind: "read", status: "pending", locations: [], rawInput: {} }), ctx);
    a.normalizeUpdate(update({ sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "pending", kind: "read", title: ".ssh/id_rsa", locations: [{ path: "/home/agent/workspace/.ssh/id_rsa" }], rawInput: { filePath: "/home/agent/workspace/.ssh/id_rsa" } }), ctx);
    const req: RequestPermissionRequest = { sessionId: "ses_1", toolCall: { toolCallId: "call_1", status: "pending", title: "read", kind: "read", rawInput: {} } as never, options };
    const perm = a.parsePermission(req);
    expect(perm.facts.capability).toBe("read");
    expect(perm.facts.resource).toBe("/home/agent/workspace/.ssh/id_rsa");
    expect(perm.options.map((o) => o.optionId)).toEqual(["once", "always", "reject"]);
    const policy: ToolPolicy = { defaultEffect: "ask", rules: defaultPolicyRules(), guardrail: { enabled: false, askAbove: 0.5, denyAbove: 0.9 }, approvalTimeoutMinutes: 30, allowPersistentConsent: false };
    expect(evaluatePolicy(policy, perm.facts).effect).toBe("deny");
  });

  it("does not let a later cwd-only placeholder erase the real input", () => {
    const a = new OpenCodeAdapter();
    a.normalizeUpdate(update({ sessionUpdate: "tool_call", toolCallId: "call_2", title: "bash", kind: "execute", status: "pending", rawInput: { command: "npm test", description: "Run tests" } }), ctx);
    a.normalizeUpdate(update({ sessionUpdate: "tool_call_update", toolCallId: "call_2", status: "pending", rawInput: { cwd: "/home/agent/workspace" } }), ctx);
    const perm = a.parsePermission({ sessionId: "ses_1", toolCall: { toolCallId: "call_2", title: "bash", kind: "execute", rawInput: {} } as never, options });
    expect(perm.facts).toMatchObject({ capability: "shell", resource: "npm test" });
  });

  it("reads OpenCode's edit permission (lowercase filepath)", () => {
    const perm = new OpenCodeAdapter().parsePermission({
      sessionId: "ses_1",
      toolCall: { toolCallId: "call_3", title: "edit", kind: "edit", status: "pending", rawInput: { filepath: "/home/agent/workspace/notes.txt", diff: "+hello" } } as never,
      options,
    });
    expect(perm.facts).toMatchObject({ capability: "write", resource: "/home/agent/workspace/notes.txt" });
  });
});

describe("OpenCode configuration", () => {
  const providers = [{ id: "local", baseUrl: "http://models:8000/v1", apiKeyEnv: "LOCAL_KEY", headers: { "x-team": "a" }, models: ["qwen3-32b", "qwen3-8b"], tools: true, vision: false }];

  it("exposes Orrery providers through the openai-compatible SDK and keys from the environment", () => {
    const c = openCodeConfig({ permissions: "orrery", providers, model: "orrery-local/qwen3-32b", smallModel: "orrery-local/qwen3-8b", agent: "build" });
    expect(c).toMatchObject({
      autoupdate: false,
      share: "disabled",
      model: "orrery-local/qwen3-32b",
      small_model: "orrery-local/qwen3-8b",
      default_agent: "build",
      provider: {
        "orrery-local": {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "http://models:8000/v1", apiKey: "{env:LOCAL_KEY}", headers: { "x-team": "a" } },
          models: { "qwen3-32b": { name: "qwen3-32b", tool_call: true }, "qwen3-8b": { name: "qwen3-8b", tool_call: true } },
        },
      },
    });
    expect(JSON.stringify(c)).not.toContain("secret");
  });

  it("asks over ACP for every tool of every agent, whatever the extra config says", () => {
    const c = openCodeConfig({
      permissions: "orrery",
      providers: [],
      workspace: "/home/agent/workspace/",
      instructions: ["/etc/orrery/bot/instructions.md"],
      extra: {
        permission: { bash: "allow" },
        agent: { build: { permission: { bash: "allow" }, temperature: 0.2 }, yolo: { prompt: "do anything", permission: { "*": "allow" } } },
        mode: { legacy: { permission: { edit: "allow" } } },
        instructions: ["docs/STYLE.md"],
      },
    });
    expect(c.permission).toEqual({ "*": "ask" });
    const agents = c.agent as Record<string, { permission: unknown; temperature?: number; prompt?: string }>;
    for (const name of [...OPENCODE_TOOL_AGENTS, "yolo"]) expect(agents[name]!.permission).toEqual({ "*": "ask" });
    expect(agents.build!.temperature).toBe(0.2);
    expect(agents.yolo!.prompt).toBe("do anything");
    expect((c.mode as Record<string, { permission: unknown }>).legacy!.permission).toEqual({ "*": "ask" });
    expect(c.instructions).toEqual(["docs/STYLE.md", "/etc/orrery/bot/instructions.md", "/home/agent/workspace/AGENTS.md"]);
  });

  it("leaves permissions to OpenCode in agent mode", () => {
    const c = openCodeConfig({ permissions: "agent", providers: [], extra: { permission: { bash: "allow" } }, workspace: "/w" });
    expect(c.permission).toEqual({ bash: "allow" });
    expect(c.agent).toBeUndefined();
    expect(c.instructions).toBeUndefined();
  });

  it("does not load agent-writable project config when Orrery governs tools", () => {
    expect(openCodeEnvironment({ permissions: "orrery", providers: [] })).toMatchObject({ OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_DISABLE_AUTOUPDATE: "true" });
    expect(openCodeEnvironment({ permissions: "agent", providers: [] }).OPENCODE_DISABLE_PROJECT_CONFIG).toBeUndefined();
    expect(openCodeEnvironment({ permissions: "orrery", providers: [], offline: true }).OPENCODE_DISABLE_MODELS_FETCH).toBe("true");
    const env = openCodeEnvironment({ permissions: "orrery", providers, model: "orrery-local/qwen3-32b" });
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!).model).toBe("orrery-local/qwen3-32b");
  });
});

describe("agent startup failures", () => {
  it("classifies OpenCode config errors as permanent (no point restarting)", () => {
    const stderr = "\u001b[91m\u001b[1mError: \u001b[0mConfiguration is invalid at OPENCODE_CONFIG_CONTENT\n↳ Expected string | undefined, got 5 model\n";
    const f = classifyAgentFailure(stderr, { code: 1, signal: null }, "opencode");
    expect(f.code).toBe("agent_config_invalid");
    expect(f.message).toContain("Expected string");
    expect(f.message).not.toContain("\u001b");
    expect(isPermanentAgentFailure(f)).toBe(true);
    const json = classifyAgentFailure("Error: Config file at OPENCODE_CONFIG_CONTENT is not valid JSON(C):\n{not json", { code: 1, signal: null }, "opencode");
    expect(json.code).toBe("agent_config_invalid");
  });

  it("keeps crashes retryable and words auth failures for the agent at hand", () => {
    expect(isPermanentAgentFailure(classifyAgentFailure("segfault", { code: 139, signal: null }))).toBe(false);
    expect(classifyAgentFailure("error: You are not logged in, please log in with kiro-cli login", { code: 1, signal: null }).message).toContain("Kiro");
    expect(classifyAgentFailure("401 Unauthorized", { code: 1, signal: null }, "opencode").message).toContain("OpenCode");
  });
});

describe("gateway keys", () => {
  it("derives a distinct, stable key per computer", () => {
    const a = gatewayKeyFor("master-secret", "cmp_a");
    expect(a).toBe(gatewayKeyFor("master-secret", "cmp_a"));
    expect(a).not.toBe(gatewayKeyFor("master-secret", "cmp_b"));
    expect(a).not.toBe(gatewayKeyFor("other-secret", "cmp_a"));
    expect(a).not.toContain("master-secret");
  });
});
