import { ApiError, type OrreryApi, type Principal, type RunEventEnvelope, type TeamNotice } from "./types";

type TokenSource = () => Promise<string | null>;

/**
 * Minimal Server-Sent Events client over fetch (EventSource cannot send Authorization headers).
 * Reconnects with backoff and resumes with Last-Event-ID.
 */
function sse(url: string, token: TokenSource, onMessage: (event: string, data: string, id: string | null) => void, onState?: (s: "connecting" | "open" | "retrying") => void): () => void {
  let stopped = false;
  let lastId: string | null = null;
  let ctrl: AbortController | null = null;
  let attempt = 0;

  const run = async () => {
    while (!stopped) {
      onState?.(attempt ? "retrying" : "connecting");
      ctrl = new AbortController();
      try {
        const t = await token();
        const res = await fetch(url, {
          headers: { accept: "text/event-stream", ...(t ? { authorization: `Bearer ${t}` } : {}), ...(lastId ? { "last-event-id": lastId } : {}) },
          signal: ctrl.signal,
          cache: "no-store",
        });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        onState?.("open");
        attempt = 0;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const raw = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            let event = "message";
            let id: string | null = null;
            const data: string[] = [];
            for (const line of raw.split("\n")) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
              else if (line.startsWith("id:")) id = line.slice(3).trim();
            }
            if (id) lastId = id;
            onMessage(event, data.join("\n"), id);
          }
        }
      } catch {
        if (stopped) return;
      }
      if (stopped) return;
      attempt++;
      await new Promise((r) => setTimeout(r, Math.min(15_000, 500 * 2 ** Math.min(attempt, 5)) * (0.75 + Math.random() / 2)));
    }
  };
  void run();
  return () => {
    stopped = true;
    ctrl?.abort();
  };
}

export class HttpApi implements OrreryApi {
  readonly mode = "live" as const;
  constructor(private readonly baseUrl: string, private readonly token: TokenSource, private readonly onUnauthorized: () => void) {}

  private async req<T>(method: string, path: string, body?: unknown, raw?: BodyInit): Promise<T> {
    const t = await this.token();
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { ...(t ? { authorization: `Bearer ${t}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    if (res.status === 401) this.onUnauthorized();
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? "error", json?.error?.message ?? res.statusText);
    return json as T;
  }
  private get = <T,>(p: string) => this.req<T>("GET", p);
  private qs(o: Record<string, string | number | boolean | undefined>): string {
    const e = Object.entries(o).filter(([, v]) => v !== undefined && v !== "");
    return e.length ? `?${new URLSearchParams(e.map(([k, v]) => [k, String(v)]))}` : "";
  }

  me = () => this.get<Principal>("/v1/me");
  listBots = async () => (await this.get<{ bots: never[] }>("/v1/bots")).bots;
  getBot = (id: string) => this.get<Awaited<ReturnType<OrreryApi["getBot"]>>>(`/v1/bots/${id}`);
  createBot: OrreryApi["createBot"] = async (input) => (await this.req<{ bot: never }>("POST", "/v1/bots", input)).bot;
  updateBot: OrreryApi["updateBot"] = async (id, patch) => (await this.req<{ bot: never }>("PATCH", `/v1/bots/${id}`, patch)).bot;
  archiveBot = async (id: string) => void (await this.req("DELETE", `/v1/bots/${id}`));

  listThreads = async (botId: string) => (await this.get<{ threads: never[] }>(`/v1/bots/${botId}/threads`)).threads;
  createThread = async (botId: string, title?: string) => (await this.req<{ thread: never }>("POST", `/v1/bots/${botId}/threads`, title ? { title } : {})).thread;
  archiveThread = async (id: string) => void (await this.req("DELETE", `/v1/threads/${id}`));
  listMessages = async (id: string) => (await this.get<{ messages: never[] }>(`/v1/threads/${id}/messages`)).messages;
  sendMessage: OrreryApi["sendMessage"] = (threadId, body) => this.req("POST", `/v1/threads/${threadId}/messages`, body);

  listRuns = async (threadId: string) => (await this.get<{ runs: never[] }>(`/v1/threads/${threadId}/runs`)).runs;
  activeRuns = async () => (await this.get<{ runs: never[] }>(`/v1/runs/active`)).runs;
  getRun = (id: string) => this.get<Awaited<ReturnType<OrreryApi["getRun"]>>>(`/v1/runs/${id}`);
  runEvents = async (id: string) => (await this.get<{ events: RunEventEnvelope[] }>(`/v1/runs/${id}/events`)).events;
  cancelRun = async (id: string) => void (await this.req("POST", `/v1/runs/${id}/cancel`));
  feedback = async (id: string, value: number, comment?: string) => void (await this.req("POST", `/v1/runs/${id}/feedback`, { value, ...(comment ? { comment } : {}) }));

  streamThread: OrreryApi["streamThread"] = (threadId, onEvent, onState) =>
    sse(`${this.baseUrl}/v1/threads/${threadId}/events`, this.token, (event, data) => {
      if (event === "run_event") onEvent(JSON.parse(data) as RunEventEnvelope);
    }, onState);
  streamTeam: OrreryApi["streamTeam"] = (onNotice) =>
    sse(`${this.baseUrl}/v1/stream`, this.token, (event, data) => {
      if (event === "run_event" || event === "approval") onNotice(JSON.parse(data) as TeamNotice);
    });

  listApprovals = async (botId?: string) => (await this.get<{ approvals: never[] }>(`/v1/approvals${this.qs({ botId })}`)).approvals;
  decideApproval: OrreryApi["decideApproval"] = async (id, d) => (await this.req<{ approval: never }>("POST", `/v1/approvals/${id}/decide`, d)).approval;

  coreMemory: OrreryApi["coreMemory"] = (botId) => this.get(`/v1/bots/${botId}/core-memory`);
  setCoreMemory: OrreryApi["setCoreMemory"] = async (botId, block, content) => void (await this.req("PUT", `/v1/bots/${botId}/core-memory/${block}`, { content }));
  listMemories: OrreryApi["listMemories"] = async (q) => (await this.get<{ memories: never[] }>(`/v1/memories${this.qs({ botId: q.botId, kind: q.kind, q: q.q, includeSuperseded: q.includeSuperseded })}`)).memories;
  writeMemory: OrreryApi["writeMemory"] = async (botId, m) => (await this.req<{ result: never }>("POST", "/v1/memories", { botId, ...m })).result;
  updateMemory: OrreryApi["updateMemory"] = async (id, patch) => (await this.req<{ memory: never }>("PATCH", `/v1/memories/${id}`, patch)).memory;
  forgetMemory = async (id: string) => void (await this.req("DELETE", `/v1/memories/${id}`));
  recall: OrreryApi["recall"] = async (botId, query) => (await this.req<{ results: never[] }>("POST", "/v1/memories/search", { botId, query })).results;
  consolidate = async (botId: string) => void (await this.req("POST", `/v1/bots/${botId}/consolidate`));

  listKnowledgeBases = async () => (await this.get<{ knowledgeBases: never[] }>("/v1/knowledge-bases")).knowledgeBases;
  createKnowledgeBase: OrreryApi["createKnowledgeBase"] = async (k) => (await this.req<{ knowledgeBase: never }>("POST", "/v1/knowledge-bases", k)).knowledgeBase;
  listSources = async (kbId: string) => (await this.get<{ sources: never[] }>(`/v1/knowledge-bases/${kbId}/sources`)).sources;
  addSource: OrreryApi["addSource"] = async (kbId, s) => {
    if (s.type === "upload") {
      const form = new FormData();
      form.set("file", s.file);
      return (await this.req<{ source: never }>("POST", `/v1/knowledge-bases/${kbId}/sources`, undefined, form)).source;
    }
    return (await this.req<{ source: never }>("POST", `/v1/knowledge-bases/${kbId}/sources`, s)).source;
  };
  deleteSource = async (id: string) => void (await this.req("DELETE", `/v1/sources/${id}`));
  reingest = async (id: string) => void (await this.req("POST", `/v1/sources/${id}/reingest`));
  searchKnowledge: OrreryApi["searchKnowledge"] = (knowledgeBaseIds, query) => this.req("POST", "/v1/knowledge/search", { knowledgeBaseIds, query });

  listRoutines = async (botId?: string) => (await this.get<{ routines: never[] }>(`/v1/routines${this.qs({ botId })}`)).routines;
  createRoutine: OrreryApi["createRoutine"] = async (r) => (await this.req<{ routine: never }>("POST", "/v1/routines", r)).routine;
  updateRoutine: OrreryApi["updateRoutine"] = async (id, p) => (await this.req<{ routine: never }>("PATCH", `/v1/routines/${id}`, p)).routine;
  deleteRoutine = async (id: string) => void (await this.req("DELETE", `/v1/routines/${id}`));
  runRoutine = async (id: string) => void (await this.req("POST", `/v1/routines/${id}/run`));

  providers: OrreryApi["providers"] = () => this.get("/v1/providers");
  testProvider: OrreryApi["testProvider"] = (id) => this.req("POST", `/v1/providers/${id}/test`);
  usage: OrreryApi["usage"] = async (days) => (await this.get<{ rows: never[] }>(`/v1/usage?days=${days}`)).rows;
  computers: OrreryApi["computers"] = async () => (await this.get<{ computers: never[] }>("/v1/computers")).computers;
  audit: OrreryApi["audit"] = async () => (await this.get<{ entries: never[] }>("/v1/audit")).entries;
  listSecrets: OrreryApi["listSecrets"] = async () => (await this.get<{ secrets: never[] }>("/v1/secrets")).secrets;
  putSecret = async (name: string, value: string) => void (await this.req("PUT", `/v1/secrets/${encodeURIComponent(name)}`, { value }));
  deleteSecret = async (name: string) => void (await this.req("DELETE", `/v1/secrets/${encodeURIComponent(name)}`));
  webhookToken: OrreryApi["webhookToken"] = (botId) => this.get(`/v1/bots/${botId}/webhook-token`);

  listGroups = async () => (await this.get<{ groups: never[] }>("/v1/groups")).groups;
  createGroup: OrreryApi["createGroup"] = async (g) => (await this.req<{ group: never }>("POST", "/v1/groups", g)).group;
  updateGroup: OrreryApi["updateGroup"] = async (id, patch) => (await this.req<{ group: never }>("PATCH", `/v1/groups/${id}`, patch)).group;
  archiveGroup = async (id: string) => void (await this.req("DELETE", `/v1/groups/${id}`));

  setup: OrreryApi["setup"] = () => this.get("/v1/setup");
  listAgentEnv: OrreryApi["listAgentEnv"] = async () => (await this.get<{ variables: never[] }>("/v1/agent-env")).variables;
  setAgentEnv = async (name: string, value: string) => void (await this.req("PUT", `/v1/agent-env/${encodeURIComponent(name)}`, { value }));
  deleteAgentEnv = async (name: string) => void (await this.req("DELETE", `/v1/agent-env/${encodeURIComponent(name)}`));
  listTokens: OrreryApi["listTokens"] = async () => (await this.get<{ tokens: never[] }>("/v1/tokens")).tokens;
  createToken: OrreryApi["createToken"] = (t) => this.req("POST", "/v1/tokens", t);
  revokeToken = async (id: string) => void (await this.req("DELETE", `/v1/tokens/${id}`));
}
