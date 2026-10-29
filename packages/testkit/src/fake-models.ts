import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";

/**
 * Deterministic fake model servers for tests and the offline demo:
 *  - OpenAI-compatible: /v1/chat/completions (stream + non-stream, tool calls), /v1/embeddings,
 *    /v1/rerank, /v1/models
 *  - System One / Clef: /v1/systemone (noul, choice, score) with keyword heuristics
 */

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Hash-based unit vector: identical texts → identical vectors; shared words → closer vectors. */
export function fakeEmbedding(text: string, dims = 64): number[] {
  const v = new Array<number>(dims).fill(0);
  const words = text.toLowerCase().match(/[a-z0-9äöå]+/g) ?? [];
  for (const w of words) {
    const h = createHash("sha256").update(w).digest();
    for (let i = 0; i < dims; i++) v[i]! += (h[i % h.length]! / 255 - 0.5) * (1 + (h[(i + 7) % h.length]! % 3));
  }
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => x / norm);
}

interface ChatMessage {
  role: string;
  content?: string | Array<{ type: string; text?: string }> | null;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
}

function textOf(m: ChatMessage | undefined): string {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  return (m.content ?? []).map((p) => p.text ?? "").join("");
}

export interface FakeServers {
  url: string;
  server: Server;
  requests: Array<{ path: string; body: Record<string, unknown> }>;
  close(): Promise<void>;
}

export async function startFakeModelServer(opts: { dims?: number } = {}): Promise<FakeServers> {
  const dims = opts.dims ?? 64;
  const requests: FakeServers["requests"] = [];
  const server = createServer(async (req, res) => {
    try {
      const body = req.method === "POST" ? await readJson(req) : {};
      const url = new URL(req.url ?? "/", "http://x");
      requests.push({ path: url.pathname, body });
      switch (url.pathname) {
        case "/v1/models":
          return send(res, 200, { data: [{ id: "fake-small" }, { id: "fake-embed" }] });
        case "/v1/embeddings": {
          const input = Array.isArray(body.input) ? (body.input as string[]) : [String(body.input ?? "")];
          return send(res, 200, { data: input.map((t, index) => ({ index, embedding: fakeEmbedding(t, dims) })), model: body.model, usage: { prompt_tokens: input.join(" ").length / 4 } });
        }
        case "/v1/rerank": {
          const query = String(body.query ?? "").toLowerCase();
          const docs = (body.documents as Array<string | { text: string }>).map((d) => (typeof d === "string" ? d : d.text));
          const qWords = new Set(query.match(/[a-z0-9]+/g) ?? []);
          const results = docs
            .map((d, index) => {
              const words = d.toLowerCase().match(/[a-z0-9]+/g) ?? [];
              const overlap = words.filter((w) => qWords.has(w)).length;
              return { index, relevance_score: overlap / Math.max(1, qWords.size) };
            })
            .sort((a, b) => b.relevance_score - a.relevance_score)
            .slice(0, Number(body.top_n ?? docs.length));
          return send(res, 200, { results });
        }
        case "/v1/chat/completions":
          return chat(body, res);
        case "/v1/systemone":
          return send(res, 200, systemOne(body));
        default:
          return send(res, 404, { error: { message: "not found" } });
      }
    } catch (err) {
      send(res, 500, { error: { message: err instanceof Error ? err.message : String(err) } });
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    server,
    requests,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

function chat(body: Record<string, unknown>, res: ServerResponse): void {
  const messages = (body.messages as ChatMessage[]) ?? [];
  const last = messages[messages.length - 1];
  const tools = (body.tools as Array<{ function: { name: string } }>) ?? [];
  const wantsJson = Boolean(body.response_format);
  let content: string | null = null;
  let toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> | undefined;

  const userText = textOf([...messages].reverse().find((m) => m.role === "user"));
  if (last?.role === "tool") {
    content = `Done. Tool said: ${textOf(last).slice(0, 200)}`;
  } else if (wantsJson) {
    // memory extraction / title generation
    if (/title/i.test(textOf(messages[0]))) content = JSON.stringify({ title: userText.split(/\s+/).slice(0, 5).join(" ") || "New chat" });
    else {
      const facts = [...userText.matchAll(/(?:remember(?: that)?|my name is|i prefer|i like)\s+([^.!?\n]+)/gi)].map((m) => m[0]!.trim());
      content = JSON.stringify({ memories: facts.map((f) => ({ kind: /prefer|like/i.test(f) ? "preference" : "fact", content: f, importance: 0.7, tags: [] })) });
    }
  } else {
    const toolMatch = userText.match(/use tool (\w+)/i);
    const tool = toolMatch ? tools.find((t) => t.function.name === toolMatch[1]) : undefined;
    if (tool) toolCalls = [{ id: `call_${Date.now()}`, type: "function", function: { name: tool.function.name, arguments: JSON.stringify({ query: userText }) } }];
    else content = `Fake answer to: ${userText}`;
  }

  const usage = { prompt_tokens: 42, completion_tokens: 12, total_tokens: 54 };
  if (!body.stream) {
    return send(res, 200, {
      id: "chatcmpl-fake",
      object: "chat.completion",
      model: body.model,
      choices: [{ index: 0, finish_reason: toolCalls ? "tool_calls" : "stop", message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) } }],
      usage,
    });
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const write = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  if (content) {
    for (const piece of content.match(/.{1,12}/gs) ?? []) write({ choices: [{ index: 0, delta: { content: piece } }] });
  }
  if (toolCalls) {
    const tc = toolCalls[0]!;
    write({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: tc.id, type: "function", function: { name: tc.function.name, arguments: "" } }] } }] });
    const args = tc.function.arguments;
    write({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, 5) } }] } }] });
    write({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(5) } }] } }] });
  }
  write({ choices: [{ index: 0, delta: {}, finish_reason: toolCalls ? "tool_calls" : "stop" }] });
  write({ choices: [], usage });
  res.write("data: [DONE]\n\n");
  res.end();
}

/** Keyword heuristics standing in for Clef: deterministic and good enough for tests. */
export function systemOne(body: Record<string, unknown>): Record<string, unknown> {
  const state = typeof body.state === "string" ? body.state : JSON.stringify(body.state ?? "");
  const stateText = state.toLowerCase();
  const questions = (body.questions ?? {}) as Record<string, { type: string; instructions?: string; criteria?: unknown }>;
  const answers: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(questions)) {
    // Classify by the question text only, not by the item embedded after "#n:".
    const instr = (q.instructions ?? "").toLowerCase().replace(/#\d+:[\s\S]*$/, "");
    // Items embedded in the question ("... Candidate #3: <text>") are part of what is judged.
    const subject = /#\d+:\s*([\s\S]*)$/.exec(q.instructions ?? "")?.[1]?.toLowerCase() ?? "";
    const s = `${stateText} ${subject}`;
    if (q.type === "noul") {
      let p = 0.2;
      if (/risk|danger|destructive|irreversible/.test(instr)) p = /rm -rf|drop table|curl .*\| *sh|sudo|mkfs|chmod 777/.test(s) ? 0.97 : 0.08;
      else if (/remember|worth/.test(instr)) p = /remember|prefer|my name|always|never|deadline|birthday|lives in|happen|is managed|uses|located/.test(s) ? 0.9 : 0.15;
      else if (/instruction|inject/.test(instr)) p = /ignore (all|previous)|system prompt|you are now/.test(s) ? 0.95 : 0.03;
      else if (/tool|computer|file|code|agent/.test(instr)) p = /run|file|repo|code|deploy|install|build|test|fix|create|browse|search the web|read:|run:/.test(s) ? 0.9 : 0.1;
      else if (/secret|credential|sensitive/.test(instr)) p = /password|api key|token|ssn|credit card/.test(s) ? 0.9 : 0.05;
      else if (/answer|sufficient|relevant/.test(instr)) p = 0.75;
      answers[id] = { type: "noul", noul: p };
    } else if (q.type === "choice") {
      const options = Object.keys((q.criteria ?? {}) as Record<string, unknown>);
      let choice = options[0] ?? "";
      const st = (typeof body.state === "object" && body.state ? body.state : {}) as Record<string, unknown>;
      if (options.includes("contradicts") && typeof st.candidate === "string" && typeof st.existing === "string") {
        const words = (t: string) => new Set(t.toLowerCase().match(/[a-z0-9]+/g) ?? []);
        const first = st.existing.split("\n")[0]!.replace(/^#0:\s*/, "");
        const a = words(first);
        const b = words(st.candidate);
        const overlap = [...b].filter((w) => a.has(w)).length / Math.max(1, Math.max(a.size, b.size));
        const rel = overlap > 0.9 ? "duplicate" : /no longer|instead|now|changed|moved/.test(st.candidate.toLowerCase()) ? "contradicts" : overlap > 0.5 ? "refines" : "unrelated";
        answers[id] = { type: "choice", choice: rel, confidence: 0.9, probabilities: Object.fromEntries(options.map((o) => [o, o === rel ? 0.9 : 0.1 / 3])) };
        continue;
      }
      if (options.includes("evidence")) {
        const qWords = new Set(String(st.question ?? "").toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
        const passage = (instr.split(":").slice(1).join(":") || instr).toLowerCase();
        const hit = [...qWords].some((w) => passage.includes(w));
        const ch = hit ? "evidence" : "noise";
        answers[id] = { type: "choice", choice: ch, confidence: 0.8, probabilities: { evidence: hit ? 0.8 : 0.1, conflict: 0.1, noise: hit ? 0.1 : 0.8 } };
        continue;
      }
      if (options.includes("duplicate") && /same|identical/.test(s)) choice = "duplicate";
      else if (options.includes("new")) choice = "new";
      if (options.includes("agent") && /run|file|repo|code|deploy|install|build|test|fix|create|read:|run:/.test(s)) choice = "agent";
      else if (options.includes("chat")) choice = options.includes("agent") && /\?$/.test(s.trim()) && s.length < 80 ? "chat" : choice;
      if (options.includes("preference") && /prefer|like/.test(s)) choice = "preference";
      if (options.includes("none") && !/password|api key|token/.test(s)) choice = "none";
      const probabilities = Object.fromEntries(options.map((o) => [o, o === choice ? 0.85 : 0.15 / Math.max(1, options.length - 1)]));
      answers[id] = { type: "choice", choice, confidence: 0.85, probabilities };
    } else if (q.type === "score") {
      const levels = (q.criteria as string[]) ?? [];
      const score = Math.min(levels.length - 1, /urgent|asap|critical|important|always/.test(s) ? levels.length - 1 : 1);
      answers[id] = { type: "score", score, confidence: 0.8, legend: levels, probabilities: Object.fromEntries(levels.map((_, i) => [String(i), i === score ? 0.8 : 0.2 / Math.max(1, levels.length - 1)])) };
    }
  }
  return { model: body.model ?? "clef", answers, usage: { input_tokens: Math.ceil(state.length / 4) } };
}
