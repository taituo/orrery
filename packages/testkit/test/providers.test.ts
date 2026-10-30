import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { OpenAICompatibleClient, ProviderRegistry, SystemOneClient, assessToolRisk, decideRoute, extractJson, openCodeModelIds, openCodeModelProblem, q } from "@orrery/providers";
import { startFakeModelServer, type FakeServers } from "../src/index.js";

let fake: FakeServers;
beforeAll(async () => {
  fake = await startFakeModelServer();
});
afterAll(async () => fake.close());

const openaiConfig = () => ({
  kind: "openai" as const,
  id: "local",
  baseUrl: `${fake.url}/v1`,
  headers: {},
  timeoutMs: 10_000,
  roles: ["chat", "fast", "extract", "embed", "rerank"] as Array<"chat" | "fast" | "extract" | "embed" | "rerank">,
  models: { chat: ["fake-small"], embed: "fake-embed", rerank: "fake-rerank" },
  capabilities: { tools: true, vision: false, jsonSchema: true },
  rerankPath: "/rerank",
});

describe("OpenAI-compatible client", () => {
  it("chats, streams with tool-call assembly, embeds and reranks", async () => {
    const c = new OpenAICompatibleClient(openaiConfig());
    const r = await c.chat({ model: "fake-small", messages: [{ role: "user", content: "hello" }] });
    expect(r.content).toBe("Fake answer to: hello");
    expect(r.usage).toMatchObject({ inputTokens: 42, outputTokens: 12 });

    const deltas: string[] = [];
    const s = await c.chatStream(
      {
        model: "fake-small",
        messages: [{ role: "user", content: "please use tool lookup now" }],
        tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: { query: { type: "string" } } } } }],
      },
      (d) => void (d.text && deltas.push(d.text)),
    );
    expect(s.finishReason).toBe("tool_calls");
    expect(s.toolCalls[0]?.function.name).toBe("lookup");
    expect(JSON.parse(s.toolCalls[0]!.function.arguments)).toEqual({ query: "please use tool lookup now" });
    expect(s.usage.totalTokens).toBe(54);

    const text = await c.chatStream({ model: "fake-small", messages: [{ role: "user", content: "stream me a sentence please" }] }, (d) => void (d.text && deltas.push(d.text)));
    expect(deltas.join("")).toBe(text.content);

    const [a, b] = await c.embed(["kubernetes temporal", "kubernetes temporal"]);
    expect(a).toEqual(b);
    const ranked = await c.rerank("temporal workflows", ["cooking pasta", "temporal workflows on kubernetes"], 2);
    expect(ranked[0]!.index).toBe(1);
  });

  it("extracts JSON from fenced or chatty output", () => {
    expect(extractJson<{ a: number }>('Sure! ```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(extractJson<number[]>("result: [1,2,3] done")).toEqual([1, 2, 3]);
    expect(() => extractJson("no json")).toThrow();
  });
});

describe("Clef decisions (System One API)", () => {
  it("answers typed questions against a self-hosted /v1/systemone", async () => {
    const clef = new SystemOneClient({ kind: "clef", id: "clef", format: "systemone", baseUrl: fake.url, model: "clef", fastModel: "clef-flash", timeoutMs: 5000 });
    const a = await clef.decide("rm -rf / --no-preserve-root", {
      risky: q.noul("Is executing this action risky or destructive?"),
      team: q.choice("Which team?", { billing: "money", technical: "outages" }),
      urgency: q.score("How urgent?", ["Can wait", "This week", "Today"]),
    });
    expect(a.risky.noul).toBeGreaterThan(0.9);
    expect(Object.keys(a.team.probabilities).sort()).toEqual(["billing", "technical"]);
    expect(a.urgency.legend).toHaveLength(3);
    const body = fake.requests.findLast((r) => r.path === "/v1/systemone")!.body;
    expect(body).toMatchObject({ model: "clef", state: "rm -rf / --no-preserve-root" });
  });

  it("speaks the Workers AI REST shape (account path, bearer, result envelope)", async () => {
    let seen: { url: string; auth: string | undefined; body: unknown } | null = null;
    const srv: Server = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        seen = { url: req.url ?? "", auth: req.headers.authorization, body: JSON.parse(data) };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: true, result: { model: "clef-flash", answers: { ok: { type: "noul", noul: 0.42 } } } }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    const clef = new SystemOneClient(
      { kind: "clef", id: "cf", format: "workers-ai", baseUrl: `http://127.0.0.1:${port}/client/v4`, accountIdEnv: "CF_ACCOUNT", apiKeyEnv: "CF_TOKEN", model: "clef", fastModel: "clef-flash", timeoutMs: 5000 },
      { CF_ACCOUNT: "acct123", CF_TOKEN: "tok" },
    );
    const a = await clef.decide("x", { ok: q.noul("ok?") }, { fast: true });
    expect(a.ok.noul).toBe(0.42);
    expect(seen).toMatchObject({ url: "/client/v4/accounts/acct123/ai/run/@cf/cloudflare/clef-flash", auth: "Bearer tok", body: { model: "clef-flash", state: "x" } });
    srv.close();
  });

  it("routes chit-chat to the fast model and tasks to the agent; fails open to primary", async () => {
    const reg = new ProviderRegistry([openaiConfig(), { kind: "clef", id: "clef", format: "systemone", baseUrl: fake.url, model: "clef", fastModel: "clef-flash", timeoutMs: 5000 }]);
    const routing = { mode: "auto" as const, agentThreshold: 0.35, fast: { kind: "openai" as const, providerId: "local", model: "fake-small", maxSteps: 4 } };
    expect((await decideRoute(reg.decisions(), routing, { parts: [{ type: "text", text: "hi there?" }], channel: "web" })).target).toBe("fast");
    expect((await decideRoute(reg.decisions(), routing, { parts: [{ type: "text", text: "fix the failing test in the repo and deploy" }], channel: "web" })).target).toBe("primary");
    expect((await decideRoute(null, routing, { parts: [{ type: "text", text: "hi" }], channel: "web" })).target).toBe("primary");
    expect((await decideRoute(reg.decisions(), { mode: "fixed", agentThreshold: 0.35 }, { parts: [{ type: "text", text: "hi" }], channel: "web" })).target).toBe("primary");
  });

  it("scores tool risk and returns null when no decision model exists", async () => {
    const reg = new ProviderRegistry([{ kind: "clef", id: "clef", format: "systemone", baseUrl: fake.url, model: "clef", fastModel: "clef-flash", timeoutMs: 5000 }]);
    const risk = await assessToolRisk(reg.decisions(), { capability: "shell", kind: "execute", resource: "sudo rm -rf /var/lib" }, { title: "Run" });
    expect(risk).toBeGreaterThan(0.9);
    expect(await assessToolRisk(null, { capability: "shell", kind: "execute", resource: "ls" }, { title: "Run" })).toBeNull();
  });

  it("falls back to an LLM decision client when Clef is not configured", async () => {
    const reg = new ProviderRegistry([openaiConfig()]);
    expect(reg.decisions()?.id).toBe("llm:local");
  });
});

describe("configuration", () => {
  it("treats empty environment values as unset", async () => {
    const { loadEnv } = await import("@orrery/core");
    const env = loadEnv({ LANGFUSE_BASE_URL: "", OIDC_ISSUER: "  ", TEMPORAL_ADDRESS: "temporal:7233", NODE_ENV: "test" } as NodeJS.ProcessEnv);
    expect(env.LANGFUSE_BASE_URL).toBeUndefined();
    expect(env.OIDC_ISSUER).toBeUndefined();
    expect(env.TEMPORAL_ADDRESS).toBe("temporal:7233");
  });
});

describe("OpenCode model ids", () => {
  it("accepts Orrery chat providers' models and other providers' ids, rejects unknown Orrery ones", () => {
    const configs = [openaiConfig(), { ...openaiConfig(), id: "embed-only", roles: ["embed"] as Array<"embed">, models: { chat: [], embed: "e" } }];
    expect(openCodeModelIds(configs)).toEqual(["orrery-local/fake-small"]);
    expect(openCodeModelProblem("orrery-local/fake-small", configs)).toBeNull();
    expect(openCodeModelProblem("anthropic/claude-sonnet-4-5", configs)).toBeNull();
    expect(openCodeModelProblem("orrery-local/gpt-9", configs)).toMatch(/no chat model "gpt-9"/);
    expect(openCodeModelProblem("orrery-embed-only/e", configs)).toMatch(/not an Orrery chat provider/);
    expect(openCodeModelProblem("no-slash", configs)).toMatch(/provider\/model/);
  });
});
