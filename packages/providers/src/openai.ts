import { OrreryError, type ContentPart, type OpenAIProviderConfig, type UsageSnapshot } from "@orrery/core";
import { getJson, postJson, readSse, request } from "./http.js";

/**
 * OpenAI-compatible client (vLLM, Ollama, llama.cpp server, LiteLLM, OpenRouter, TEI, Jina,
 * OpenAI itself...). Plain fetch, no vendor SDK, so every compatible server works the same way.
 */

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: ChatRole;
  content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> | null;
  name?: string;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

export interface ChatTool {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  toolChoice?: "auto" | "none" | "required";
  temperature?: number;
  maxTokens?: number;
  /** JSON schema for structured output (falls back to json_object if the server lacks it). */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  signal?: AbortSignal;
}

export interface ChatResult {
  content: string;
  toolCalls: ChatToolCall[];
  finishReason: string;
  usage: UsageSnapshot;
  model: string;
}

interface WireChoice {
  message?: { content?: string | null; tool_calls?: ChatToolCall[] };
  delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: Array<{ index: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }> };
  finish_reason?: string | null;
}

interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

function usageFrom(u: WireUsage | undefined): UsageSnapshot {
  if (!u) return {};
  return {
    ...(u.prompt_tokens !== undefined ? { inputTokens: u.prompt_tokens } : {}),
    ...(u.completion_tokens !== undefined ? { outputTokens: u.completion_tokens } : {}),
    ...(u.total_tokens !== undefined ? { totalTokens: u.total_tokens } : {}),
    ...(u.prompt_tokens_details?.cached_tokens !== undefined ? { cachedReadTokens: u.prompt_tokens_details.cached_tokens } : {}),
    ...(u.completion_tokens_details?.reasoning_tokens !== undefined ? { thoughtTokens: u.completion_tokens_details.reasoning_tokens } : {}),
  };
}

export class OpenAICompatibleClient {
  readonly id: string;

  constructor(
    readonly config: OpenAIProviderConfig,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {
    this.id = config.id;
  }

  private url(path: string): string {
    return this.config.baseUrl.replace(/\/+$/, "") + path;
  }

  private headers(): Record<string, string> {
    const key = this.config.apiKeyEnv ? this.env[this.config.apiKeyEnv] : undefined;
    return { ...(key ? { authorization: `Bearer ${key}` } : {}), ...this.config.headers };
  }

  private body(req: ChatRequest, stream: boolean): Record<string, unknown> {
    return {
      model: req.model,
      messages: req.messages,
      ...(req.tools?.length && this.config.capabilities.tools ? { tools: req.tools, tool_choice: req.toolChoice ?? "auto" } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
      ...(req.jsonSchema
        ? this.config.capabilities.jsonSchema
          ? { response_format: { type: "json_schema", json_schema: { name: req.jsonSchema.name, schema: req.jsonSchema.schema, strict: false } } }
          : { response_format: { type: "json_object" } }
        : {}),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    };
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const res = await postJson<{ choices: WireChoice[]; usage?: WireUsage; model?: string }>(this.url("/chat/completions"), this.body(req, false), {
      timeoutMs: this.config.timeoutMs,
      headers: this.headers(),
      ...(req.signal ? { signal: req.signal } : {}),
    });
    const choice = res.choices?.[0];
    if (!choice) throw new OrreryError("provider_error", "chat completion returned no choices");
    return {
      content: choice.message?.content ?? "",
      toolCalls: choice.message?.tool_calls ?? [],
      finishReason: choice.finish_reason ?? "stop",
      usage: usageFrom(res.usage),
      model: res.model ?? req.model,
    };
  }

  /** Streaming chat; `onDelta` receives text and reasoning deltas as they arrive. */
  async chatStream(req: ChatRequest, onDelta: (d: { text?: string; reasoning?: string }) => void | Promise<void>): Promise<ChatResult> {
    const res = await request(this.url("/chat/completions"), { method: "POST", body: JSON.stringify(this.body(req, true)) }, {
      timeoutMs: this.config.timeoutMs,
      headers: this.headers(),
      retries: 2,
      ...(req.signal ? { signal: req.signal } : {}),
    });
    let content = "";
    let finishReason = "stop";
    let usage: UsageSnapshot = {};
    let model = req.model;
    const calls = new Map<number, ChatToolCall>();
    for await (const data of readSse(res)) {
      if (data === "[DONE]") break;
      let chunk: { choices?: WireChoice[]; usage?: WireUsage; model?: string };
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk.model) model = chunk.model;
      if (chunk.usage) usage = usageFrom(chunk.usage);
      for (const choice of chunk.choices ?? []) {
        const d = choice.delta;
        if (d?.content) {
          content += d.content;
          await onDelta({ text: d.content });
        }
        if (d?.reasoning_content) await onDelta({ reasoning: d.reasoning_content });
        for (const tc of d?.tool_calls ?? []) {
          const cur = calls.get(tc.index) ?? { id: tc.id ?? `call_${tc.index}`, type: "function" as const, function: { name: "", arguments: "" } };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.function.name += tc.function.name;
          if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
          calls.set(tc.index, cur);
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    }
    return { content, toolCalls: [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c), finishReason, usage, model };
  }

  /** Structured JSON output with schema; tolerant to servers wrapping JSON in prose/fences. */
  async json<T>(req: Omit<ChatRequest, "jsonSchema"> & { schema: Record<string, unknown>; schemaName: string }): Promise<{ value: T; usage: UsageSnapshot }> {
    const r = await this.chat({ ...req, jsonSchema: { name: req.schemaName, schema: req.schema }, temperature: req.temperature ?? 0 });
    return { value: extractJson<T>(r.content), usage: r.usage };
  }

  async embed(texts: string[], model?: string, signal?: AbortSignal): Promise<number[][]> {
    const m = model ?? this.config.models.embed;
    if (!m) throw new OrreryError("bad_request", `provider ${this.id} has no embedding model configured`);
    if (!texts.length) return [];
    const res = await postJson<{ data: Array<{ index: number; embedding: number[] }> }>(
      this.url("/embeddings"),
      { model: m, input: texts, encoding_format: "float" },
      { timeoutMs: this.config.timeoutMs, headers: this.headers(), ...(signal ? { signal } : {}) },
    );
    const out = new Array<number[]>(texts.length);
    for (const d of res.data) out[d.index] = d.embedding;
    if (out.some((v) => !v)) throw new OrreryError("provider_error", "embedding response missing vectors");
    return out;
  }

  async rerank(query: string, documents: string[], topN?: number, signal?: AbortSignal): Promise<Array<{ index: number; score: number }>> {
    const m = this.config.models.rerank;
    if (!m) throw new OrreryError("bad_request", `provider ${this.id} has no rerank model configured`);
    const res = await postJson<{ results?: Array<{ index: number; relevance_score?: number; score?: number }>; data?: Array<{ index: number; score: number }> }>(
      this.url(this.config.rerankPath),
      { model: m, query, documents, ...(topN ? { top_n: topN } : {}) },
      { timeoutMs: this.config.timeoutMs, headers: this.headers(), ...(signal ? { signal } : {}) },
    );
    const list = res.results ?? res.data ?? [];
    return list.map((r) => ({ index: r.index, score: (r as { relevance_score?: number }).relevance_score ?? (r as { score?: number }).score ?? 0 }));
  }

  async listModels(): Promise<string[]> {
    const res = await getJson<{ data?: Array<{ id: string }> }>(this.url("/models"), { timeoutMs: 10_000, headers: this.headers(), retries: 0 });
    return (res.data ?? []).map((m) => m.id);
  }
}

/** Extract the first JSON object/array from model output (handles ```json fences and prose). */
export function extractJson<T>(text: string): T {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    /* fall through */
  }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence) {
    try {
      return JSON.parse(fence[1]!.trim()) as T;
    } catch {
      /* fall through */
    }
  }
  const start = trimmed.search(/[[{]/);
  if (start >= 0) {
    const open = trimmed[start]!;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inStr = false;
    for (let i = start; i < trimmed.length; i++) {
      const c = trimmed[i]!;
      if (inStr) {
        if (c === "\\") i++;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close && --depth === 0) return JSON.parse(trimmed.slice(start, i + 1)) as T;
    }
  }
  throw new OrreryError("provider_error", `model did not return JSON: ${trimmed.slice(0, 200)}`);
}

/** Orrery content parts → OpenAI message content. */
export function toOpenAIContent(parts: ContentPart[], vision: boolean): ChatMessage["content"] {
  const out: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [];
  for (const p of parts) {
    if (p.type === "text") out.push({ type: "text", text: p.text });
    else if (p.type === "image" && vision && (p.data || p.uri)) out.push({ type: "image_url", image_url: { url: p.data ? `data:${p.mimeType};base64,${p.data}` : p.uri! } });
    else if (p.type === "resource" && p.resource.text) out.push({ type: "text", text: `\n<resource uri="${p.resource.uri}">\n${p.resource.text}\n</resource>\n` });
    else if (p.type === "resource_link") out.push({ type: "text", text: `[${p.title ?? p.name}](${p.uri})` });
  }
  if (out.every((x) => x.type === "text")) return out.map((x) => (x as { text: string }).text).join("");
  return out;
}
