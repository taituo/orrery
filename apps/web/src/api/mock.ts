import type {
  AgentEvent,
  Approval,
  AuditEntry,
  Bot,
  BotCreate,
  BotState,
  ComputerRow,
  KnowledgeBase,
  KnowledgeSource,
  MemoryItem,
  Message,
  OrreryApi,
  Principal,
  Routine,
  Run,
  RunEventEnvelope,
  TeamNotice,
  Thread,
  UsageRow,
  WriteOutcome,
} from "./types";
import { ApiError } from "./types";

/**
 * In-browser implementation of the Orrery API used by the clickable prototype and by
 * `?mock=1` in development. It simulates the real event vocabulary a Kiro CLI V3 / v2, OpenCode or
 * OpenAI-compatible turn produces (tool calls, plans, approvals with the agent's own
 * options, steering, usage/credits, memory writes), so the UI is exercised exactly as it
 * would be against the platform.
 */

const TEAM = "team_northwind";
const ME: Principal = { userId: "usr_tuomas", teamId: TEAM, role: "owner", name: "Tuomas", email: "tuomas@example.com" };

let counter = 0;
const uid = (p: string) => `${p}_${Date.now().toString(36)}${(counter++).toString(36).padStart(3, "0")}${Math.random().toString(36).slice(2, 6)}`;
const now = () => new Date().toISOString();
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clone = <T,>(v: T): T => structuredClone(v);

const basePolicy = (): Bot["policy"] => ({
  defaultEffect: "ask",
  rules: [
    { id: "allow-read", effect: "allow", capability: "read", resource: "**" },
    { id: "allow-search", effect: "allow", capability: "search", resource: "**" },
    { id: "allow-kubectl-read", effect: "allow", capability: "shell", resource: "kubectl {get,describe,logs,top} **" },
    { id: "ask-kubectl-mutations", effect: "ask", capability: "shell", resource: "kubectl **", reason: "Cluster changes need a human" },
    { id: "deny-secrets", effect: "deny", capability: "read", resource: "**/.env*", reason: "Never read env files" },
    { id: "allow-orrery-memory", effect: "allow", capability: "mcp", resource: "orrery/{memory_search,knowledge_search,conversation_history}" },
  ],
  guardrail: { enabled: true, askAbove: 0.5, denyAbove: 0.92 },
  approvalTimeoutMinutes: 1440,
  allowPersistentConsent: true,
});

const computer = (over: Partial<Bot["computer"]> = {}): Bot["computer"] => ({ enabled: true, size: "small", idleMinutes: 60, persistentHome: true, shared: false, network: { mode: "restricted", allow: ["github.com", "*.githubusercontent.com", "registry.npmjs.org"] }, ...over });
const memorySettings = (over: Partial<Bot["memory"]> = {}): Bot["memory"] => ({ enabled: true, autoExtract: true, recallK: 8, shareScope: "bot", coreMemoryCharLimit: 4000, ...over });

function seedBots(): Bot[] {
  const mk = (b: Partial<Bot> & Pick<Bot, "id" | "name" | "primary">): Bot => ({
    teamId: TEAM,
    description: "",
    instructions: "",
    routing: { mode: "fixed", agentThreshold: 0.35 },
    policy: basePolicy(),
    computer: computer(),
    memory: memorySettings(),
    knowledgeBaseIds: [],
    mcpServers: [],
    peers: [],
    status: "active",
    createdAt: ago(60 * 24 * 30),
    updatedAt: ago(60 * 5),
    ...b,
  });
  return [
    mk({
      id: "bot_ada",
      name: "Ada",
      avatar: "A",
      description: "On-call platform engineer for the staging and production clusters.",
      instructions: "You are Ada, the platform team's on-call teammate. Prefer reading state before changing it. Never restart production workloads without approval. Summarize findings as: what's wrong, evidence, what you did, what's next.",
      primary: { kind: "kiro-acp", engine: "v3", modeId: "vibe", modelId: "claude-sonnet-4.5", effort: "high", authMethod: "cli" },
      knowledgeBaseIds: ["kb_runbooks"],
      mcpServers: [{ type: "http", name: "pagerduty", url: "https://mcp.pagerduty.example/mcp", headers: [{ name: "Authorization", value: "secret://pagerduty-token" }] }],
      peers: ["bot_quill", "bot_scout"],
    }),
    mk({
      id: "bot_scout",
      name: "Scout",
      avatar: "S",
      description: "Research and triage. Answers quick questions with a small model, digs in with Kiro when needed.",
      instructions: "You are Scout. Be brief. Cite sources.",
      primary: { kind: "kiro-acp", engine: "auto", authMethod: "cli" },
      routing: { mode: "auto", fast: { kind: "openai", providerId: "local-vllm", model: "qwen3-30b-a3b", maxSteps: 8 }, agentThreshold: 0.35 },
      memory: memorySettings({ shareScope: "team" }),
      knowledgeBaseIds: ["kb_runbooks", "kb_product"],
      mcpServers: [{ type: "http", name: "github", url: "https://api.githubcopilot.com/mcp/", headers: [{ name: "Authorization", value: "secret://github-token" }] }],
    }),
    mk({
      id: "bot_quill",
      name: "Quill",
      avatar: "Q",
      description: "Keeps the docs site and changelogs current. Runs on the legacy Kiro CLI v2 engine.",
      instructions: "You are Quill, a technical writer. Match the existing docs voice.",
      primary: { kind: "kiro-acp", engine: "v2", modeId: "docs-writer", modelId: "claude-sonnet-4.5", authMethod: "cli" },
      knowledgeBaseIds: ["kb_product"],
    }),
    mk({
      id: "bot_patch",
      name: "Patch",
      avatar: "P",
      description: "Fixes flaky tests and small bugs in the web repo. Runs OpenCode on the team's self-hosted model.",
      instructions: "You are Patch. Reproduce first, change as little as possible, and run the affected tests before you report back.",
      primary: { kind: "opencode-acp", modeId: "build", modelId: "orrery-local-vllm/qwen3-235b-a22b", smallModelId: "orrery-local-vllm/qwen3-30b-a3b", permissions: "orrery" },
      computer: computer({ network: { mode: "restricted", allow: ["github.com", "registry.npmjs.org"] } }),
      mcpServers: [{ type: "http", name: "github", url: "https://api.githubcopilot.com/mcp/", headers: [{ name: "Authorization", value: "secret://github-token" }] }],
    }),
    mk({
      id: "bot_ledger",
      name: "Ledger",
      avatar: "L",
      description: "Cloud cost analyst. Uses the team's self-hosted model through an OpenAI-compatible endpoint.",
      instructions: "You are Ledger. Report costs in EUR with week-over-week change.",
      primary: { kind: "openai", providerId: "local-vllm", model: "qwen3-235b-a22b", maxSteps: 12 },
      computer: computer({ enabled: false }),
    }),
    mk({
      id: "bot_relay",
      name: "Relay",
      avatar: "R",
      description: "Customer escalations bridge. Paused while the support rotation is reorganized.",
      primary: { kind: "kiro-acp", engine: "v3", authMethod: "cli" },
      status: "paused",
    }),
  ];
}

const seedMemories = (): MemoryItem[] => {
  const m = (botId: string | null, kind: MemoryItem["kind"], content: string, importance: number, extra: Partial<MemoryItem> = {}): MemoryItem => ({
    id: uid("mem"),
    teamId: TEAM,
    botId,
    userId: null,
    scope: botId ? "bot" : "team",
    kind,
    content,
    tags: [],
    importance,
    confidence: 0.9,
    pinned: false,
    source: { type: "turn" },
    validFrom: ago(60 * 24 * 12),
    validTo: null,
    supersededBy: null,
    accessCount: Math.floor(importance * 20),
    lastAccessedAt: ago(90),
    createdAt: ago(60 * 24 * 12),
    updatedAt: ago(60 * 24 * 2),
    ...extra,
  });
  const old = m("bot_ada", "fact", "Staging runs in eu-west-1 on EKS 1.29.", 0.7, { validTo: ago(60 * 24 * 3), createdAt: ago(60 * 24 * 40) });
  const cur = m("bot_ada", "fact", "Staging runs in eu-north-1 on EKS 1.31 (migrated from eu-west-1 in October).", 0.8, { createdAt: ago(60 * 24 * 3), validFrom: ago(60 * 24 * 3) });
  old.supersededBy = cur.id;
  return [
    cur,
    old,
    m("bot_ada", "procedure", "To restart the api on staging, prefer `kubectl rollout restart deploy/api -n staging` over deleting pods; watch `rollout status` until healthy.", 0.85, { pinned: true, source: { type: "user" } }),
    m("bot_ada", "preference", "Tuomas wants incident summaries as four short sections: what's wrong, evidence, what was done, next steps.", 0.75),
    m("bot_ada", "entity", "payments-gateway is owned by the Payments team (#team-payments); page them before touching it.", 0.7),
    m("bot_ada", "episode_summary", "Oct 21: api 502s on staging traced to a bad ConfigMap rollout; fixed by reverting values.yaml and restarting the deployment.", 0.6, { source: { type: "consolidation" } }),
    m("bot_scout", "fact", "The public docs site is built from the `docs/` folder of northwind/web with Astro.", 0.6),
    m(null, "instruction", "Never paste customer PII into tickets or chat; link to the CRM record instead.", 0.95, { pinned: true, source: { type: "user" } }),
    m("bot_ledger", "fact", "Monthly AWS budget for the platform account is €18,000.", 0.8),
    m("bot_quill", "preference", "Changelog entries use present tense and start with the affected area, e.g. 'API: …'.", 0.7),
  ];
};

type Scenario = "incident" | "quick" | "research" | "docs" | "costs";

interface LiveRun {
  run: Run;
  cancelled: boolean;
  steer: string[];
  approval: { id: string; resolve: (optionId: string | null) => void } | null;
  /** The run's own emitter, so out-of-band events (steering) share its sequence. */
  emit: (e: AgentEvent) => void;
}

export class MockApi implements OrreryApi {
  readonly mode = "mock" as const;
  private bots = seedBots();
  private threads: Thread[] = [];
  private messages: Message[] = [];
  private runs: Run[] = [];
  private events: RunEventEnvelope[] = [];
  private approvals: Approval[] = [];
  private memories = seedMemories();
  private core: Record<string, Record<"persona" | "human" | "notes", string>> = {};
  private kbs: KnowledgeBase[] = [
    { id: "kb_runbooks", teamId: TEAM, name: "Runbooks", description: "Operational runbooks for staging and production.", embeddingModel: "bge-m3", embeddingDims: 1024, chunkSize: 1200, chunkOverlap: 150, createdAt: ago(60 * 24 * 60) },
    { id: "kb_product", teamId: TEAM, name: "Product docs", description: "Public documentation and release notes.", embeddingModel: "bge-m3", embeddingDims: 1024, chunkSize: 1200, chunkOverlap: 150, createdAt: ago(60 * 24 * 50) },
  ];
  private sources: Array<KnowledgeSource & { text: string }> = [
    { id: "src_1", knowledgeBaseId: "kb_runbooks", type: "url", uri: "https://wiki.northwind.example/runbooks/staging-api", title: "Staging api runbook", mimeType: "text/html", status: "ready", error: null, stats: { chunks: 14, rejected: 0, bytes: 18234 }, createdAt: ago(60 * 24 * 20), updatedAt: ago(60 * 24 * 2), text: "Staging api runbook. Symptoms: 502 from the ingress usually mean the api pods are failing readiness. Check kubectl get pods -n staging -l app=api, then logs. Restart with kubectl rollout restart deploy/api -n staging. If a ConfigMap changed recently, revert values.yaml first." },
    { id: "src_2", knowledgeBaseId: "kb_runbooks", type: "upload", uri: "incident-process.md", title: "Incident process", mimeType: "text/markdown", status: "ready", error: null, stats: { chunks: 6, rejected: 1, bytes: 7420 }, createdAt: ago(60 * 24 * 18), updatedAt: ago(60 * 24 * 18), text: "Declare incidents in #incidents with /incident new. Sev2 and above page the on-call lead. Post updates every 30 minutes." },
    { id: "src_3", knowledgeBaseId: "kb_runbooks", type: "url", uri: "https://wiki.northwind.example/runbooks/db-failover", title: "Database failover", mimeType: "text/html", status: "failed", error: "Fetch failed: 403 from wiki.northwind.example (the bot computer's egress allowlist does not include this host)", stats: {}, createdAt: ago(60 * 24), updatedAt: ago(60 * 24), text: "" },
    { id: "src_4", knowledgeBaseId: "kb_product", type: "url", uri: "https://docs.northwind.example/changelog", title: "Changelog", mimeType: "text/html", status: "ready", error: null, stats: { chunks: 42, rejected: 0, bytes: 61200 }, createdAt: ago(60 * 24 * 30), updatedAt: ago(60 * 6), text: "Changelog. API: rate limits are now per token. Dashboard: new usage view. Billing: invoices in EUR." },
  ];
  private routines: Routine[] = [
    { id: "rtn_1", teamId: TEAM, botId: "bot_ada", name: "Morning cluster check", prompt: "Check staging and production health: failing pods, pending PVCs, certificate expiry under 14 days. Post a short summary.", schedule: { cron: "50 6 * * 1-5", timezone: "Europe/Helsinki" }, threadPolicy: "reuse", threadId: null, enabled: true, lastRunAt: ago(60 * 3), createdAt: ago(60 * 24 * 14) },
    { id: "rtn_2", teamId: TEAM, botId: "bot_ledger", name: "Weekly cost report", prompt: "Summarize last week's cloud spend by service with week-over-week change and anything unusual.", schedule: { cron: "0 9 * * 1", timezone: "Europe/Helsinki" }, threadPolicy: "new", threadId: null, enabled: true, lastRunAt: ago(60 * 24 * 3), createdAt: ago(60 * 24 * 40) },
    { id: "rtn_3", teamId: TEAM, botId: "bot_quill", name: "Changelog draft", prompt: "Draft changelog entries for PRs merged since the last release.", schedule: { intervalMinutes: 720, timezone: "UTC" }, threadPolicy: "reuse", threadId: null, enabled: false, lastRunAt: ago(60 * 24 * 9), createdAt: ago(60 * 24 * 30) },
  ];
  private secrets = [
    { name: "github-token", createdAt: ago(60 * 24 * 20) },
    { name: "pagerduty-token", createdAt: ago(60 * 24 * 12) },
    { name: "kiro-api-key", createdAt: ago(60 * 24 * 30) },
  ];
  private auditLog: AuditEntry[] = [];
  private live = new Map<string, LiveRun>();
  private threadSubs = new Map<string, Set<(e: RunEventEnvelope) => void>>();
  private teamSubs = new Set<(n: TeamNotice) => void>();

  constructor() {
    for (const b of this.bots) this.core[b.id] = { persona: b.instructions.slice(0, 4000), human: b.id === "bot_ada" ? "Tuomas leads the platform team; prefers concise answers, Finnish time (EET)." : "", notes: "" };
    this.audit_("bot.update", "bot_ada", { fields: ["policy"] }, 60 * 26);
    this.audit_("approval.decide", "apr_seed", { status: "approved", option: "allow_once", resource: "kubectl rollout restart deploy/api -n staging" }, 60 * 24 * 2);
    this.audit_("secret.put", "pagerduty-token", {}, 60 * 24 * 12);
    void this.seedHistory();
  }

  /* ----------------------------------------------------------------------- seeding */

  private async seedHistory(): Promise<void> {
    const t1 = this.mkThread("bot_ada", "Staging api returning 502s", "web", 60 * 26);
    await this.simulate(t1, "Staging api is returning 502s since this morning, can you check?", "incident", { instant: true, at: 60 * 26, autoDecide: "allow" });
    const t2 = this.mkThread("bot_ada", "Morning cluster check", "routine", 60 * 3);
    await this.simulate(t2, "Check staging and production health: failing pods, pending PVCs, certificate expiry under 14 days. Post a short summary.", "research", { instant: true, at: 60 * 3, author: { type: "system", id: "routine:rtn_1", name: "Morning cluster check" } });
    const t3 = this.mkThread("bot_ledger", "October cost review", "web", 60 * 30);
    await this.simulate(t3, "What drove the cost increase in October?", "costs", { instant: true, at: 60 * 30 });
    const t4 = this.mkThread("bot_quill", "Changelog for 2.14", "web", 60 * 50);
    await this.simulate(t4, "Draft the changelog for 2.14 from the merged PRs.", "docs", { instant: true, at: 60 * 50 });
    const t5 = this.mkThread("bot_scout", "Quick question", "web", 60 * 8);
    await this.simulate(t5, "What's our rate limit policy for API tokens?", "quick", { instant: true, at: 60 * 8 });

    // Live: Scout is waiting on an approval; Ada is working an incident.
    const t6 = this.mkThread("bot_scout", "Fix broken links in docs", "web", 12);
    void this.simulate(t6, "The docs build reports 3 broken links. Fix them and open a PR.", "docs", { at: 12, botOverride: "bot_scout", fastForwardToApproval: true });
    const t7 = this.mkThread("bot_ada", "payments-gateway latency", "webhook", 2);
    void this.simulate(t7, "PagerDuty: payments-gateway p99 latency above 2s on production for 10 minutes.", "incident", { at: 2, author: { type: "system", id: "webhook:pagerduty", name: "pagerduty" }, slow: true });
  }

  private mkThread(botId: string, title: string, channel: Thread["channel"], minutesAgo: number): Thread {
    const t: Thread = { id: uid("thr"), teamId: TEAM, botId, title, channel, acpSessionId: null, createdBy: ME.userId, archived: false, lastActivityAt: ago(minutesAgo), createdAt: ago(minutesAgo) };
    this.threads.unshift(t);
    return t;
  }

  private audit_(action: string, target: string | null, data: Record<string, unknown> = {}, minutesAgo = 0): void {
    this.auditLog.unshift({ id: this.auditLog.length + 1, actor: ME.userId, action, target, data, created_at: ago(minutesAgo) });
  }

  /* ----------------------------------------------------------------------- simulation */

  private pickScenario(bot: Bot, text: string): Scenario {
    const t = text.toLowerCase();
    if (bot.routing.mode === "auto" && (t.length < 60 || /^(thanks|thank you|ok|cool|hi|hello)/.test(t)) && !/fix|deploy|restart|pr\b|pull request/.test(t)) return "quick";
    if (/cost|spend|budget|invoice|€|eur/.test(t) || bot.id === "bot_ledger") return "costs";
    if (/doc|changelog|readme|link|write/.test(t) || bot.id === "bot_quill") return "docs";
    if (/502|500|error|latency|restart|pod|deploy|down|red|incident|crash|alert/.test(t)) return "incident";
    return "research";
  }

  private emitTeam(n: TeamNotice): void {
    for (const s of this.teamSubs) s(n);
  }

  private async simulate(
    thread: Thread,
    text: string,
    forced: Scenario | null,
    opts: { instant?: boolean; at?: number; autoDecide?: "allow" | "deny"; author?: Message["author"]; botOverride?: string; fastForwardToApproval?: boolean; slow?: boolean; existingMessageId?: string } = {},
  ): Promise<Run> {
    const bot = this.bots.find((b) => b.id === (opts.botOverride ?? thread.botId))!;
    let clock = opts.at !== undefined ? Date.now() - opts.at * 60_000 : Date.now();
    const instant = Boolean(opts.instant);
    const ts = () => (instant ? new Date((clock += 900)).toISOString() : now());
    const userMsg: Message = opts.existingMessageId
      ? this.messages.find((m) => m.id === opts.existingMessageId)!
      : { id: uid("msg"), threadId: thread.id, role: "user", author: opts.author ?? { type: "user", id: ME.userId, name: ME.name ?? "You" }, parts: [{ type: "text", text }], createdAt: ts() };
    if (!opts.existingMessageId) this.messages.push(userMsg);
    const scenario = forced ?? this.pickScenario(bot, text);
    const isFast = scenario === "quick";
    const engine = bot.primary.kind === "kiro-acp" ? (bot.primary.engine === "auto" ? "v3" : bot.primary.engine) : bot.primary.kind === "opencode-acp" ? "opencode" : undefined;
    const run: Run = {
      id: uid("run"),
      teamId: TEAM,
      botId: bot.id,
      threadId: thread.id,
      triggerMessageId: userMsg.id,
      status: "running",
      provider: isFast ? "openai" : bot.primary.kind,
      model: isFast ? (bot.routing.fast?.model ?? null) : bot.primary.kind === "openai" ? bot.primary.model : bot.primary.kind === "kiro-acp" ? (bot.primary.modelId ?? "auto") : bot.primary.kind === "opencode-acp" ? (bot.primary.modelId ?? null) : null,
      engine: isFast ? null : (engine ?? null),
      stopReason: null,
      usage: {},
      error: null,
      workflowId: `turn:${thread.id}`,
      traceId: Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32),
      startedAt: ts(),
      endedAt: null,
    } as Run;
    this.runs.push(run);
    const lr: LiveRun = { run, cancelled: false, steer: [], approval: null, emit: () => undefined };
    this.live.set(run.id, lr);
    let seq = 0;
    const emit = (lr.emit = (event: AgentEvent) => {
      const env: RunEventEnvelope = { id: `${run.id}:${++seq}`, runId: run.id, threadId: thread.id, botId: bot.id, seq, ts: ts(), event };
      this.events.push(env);
      thread.lastActivityAt = env.ts;
      if (!instant) {
        for (const s of this.threadSubs.get(thread.id) ?? []) s(env);
        this.emitTeam({ kind: "run_event", runId: run.id, threadId: thread.id, seq });
      }
    });
    const pace = opts.slow ? 1.6 : 1;
    const pause = async (ms: number) => {
      if (instant || opts.fastForwardToApproval) return;
      await wait(ms * pace);
    };
    const checkpoint = () => {
      if (lr.cancelled) throw new Cancelled();
      if (lr.steer.length) {
        for (const s of lr.steer.splice(0)) emit({ type: "steering", status: "injected", text: s });
        steered = true;
      }
    };
    let steered = false;
    const say = async (md: string) => {
      const msgId = uid("amsg");
      const chunks = md.match(/[^\s]+\s*/g) ?? [md];
      for (let i = 0; i < chunks.length; i += 3) {
        checkpoint();
        emit({ type: "message.delta", messageId: msgId, part: { type: "text", text: chunks.slice(i, i + 3).join("") } });
        await pause(45);
      }
      return md;
    };
    const think = async (t: string) => {
      const msgId = uid("th");
      for (const c of t.match(/.{1,48}(\s|$)/g) ?? [t]) {
        emit({ type: "thought.delta", messageId: msgId, part: { type: "text", text: c } });
        await pause(40);
      }
    };
    let toolN = 0;
    const tool = async (t: { title: string; kind: Parameters<typeof emitTool>[1]; input: unknown; output: string; locations?: Array<{ path: string; line?: number }>; identity?: { source: "builtin" | "mcp" | "platform"; server?: string; tool?: string }; terminal?: boolean; diff?: { path: string; oldText: string; newText: string }; ms?: number; fail?: string }) => {
      checkpoint();
      const id = `call_${++toolN}_${run.id.slice(-4)}`;
      emitTool(id, t.kind, t);
      await pause(t.ms ?? 900);
      emit({ type: "tool.update", toolCallId: id, patch: { status: "in_progress" } });
      await pause(t.ms ?? 900);
      checkpoint();
      if (t.fail) {
        emit({ type: "tool.update", toolCallId: id, patch: { status: "failed", failureReason: "error", content: [{ type: "content", content: { type: "text", text: t.fail } }] } });
        return id;
      }
      emit({
        type: "tool.update",
        toolCallId: id,
        patch: {
          status: "completed",
          rawOutput: { output: t.output },
          content: t.diff ? [{ type: "diff", path: t.diff.path, oldText: t.diff.oldText, newText: t.diff.newText }] : [{ type: "content", content: { type: "text", text: t.output } }],
        },
      });
      return id;
    };
    function emitTool(id: string, kind: "read" | "edit" | "execute" | "search" | "fetch" | "think" | "other", t: { title: string; input: unknown; locations?: Array<{ path: string; line?: number }>; identity?: { source: "builtin" | "mcp" | "platform"; server?: string; tool?: string } }) {
      emit({ type: "tool.preview", toolCallId: id, title: t.title, kind });
      emit({ type: "tool.call", call: { toolCallId: id, title: t.title, kind, status: "pending", rawInput: t.input, ...(t.locations ? { locations: t.locations } : {}), identity: t.identity ?? { source: "builtin" } } });
    }
    const ask = async (a: { title: string; kind: "execute" | "edit" | "other"; input: unknown; resource: string; capability: string; rule: string; risk: number; identity?: { source: "mcp" | "builtin"; server?: string; tool?: string }; annotations?: Record<string, boolean>; options?: Approval["options"] }): Promise<{ allowed: boolean; toolCallId: string }> => {
      checkpoint();
      const id = `call_${++toolN}_${run.id.slice(-4)}`;
      emitTool(id, a.kind, { title: a.title, input: a.input, ...(a.identity ? { identity: a.identity } : {}) });
      const options: Approval["options"] =
        a.options ??
        (engine === "opencode"
          ? [
              { optionId: "once", name: "Allow once", kind: "allow_once" },
              { optionId: "always", name: "Always allow", kind: "allow_always" },
              { optionId: "reject", name: "Reject", kind: "reject_once" },
            ]
          : engine === "v2"
          ? [
              { optionId: "allow_once", name: "Yes", kind: "allow_once" },
              { optionId: "trust_tool", name: "Trust this tool", kind: "allow_always" },
              { optionId: "reject_once", name: "No", kind: "reject_once" },
            ]
          : [
              { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
              { optionId: "allow-always", name: "Always allow in this workspace", kind: "allow_always" },
              { optionId: "reject-once", name: "Deny", kind: "reject_once" },
            ]);
      const approval: Approval = {
        id: `apr_${id}`,
        teamId: TEAM,
        botId: bot.id,
        threadId: thread.id,
        runId: run.id,
        toolCallId: id,
        title: a.title,
        kind: a.kind,
        capability: a.capability,
        resource: a.resource,
        rawInput: a.input,
        options,
        consent: engine === "v3" ? { capability: a.capability, resource: a.resource, workspaceRoot: "/home/agent/work", persistableConsent: true } : null,
        mcpTool: a.identity?.source === "mcp" ? { server: a.identity.server!, tool: a.identity.tool!, ...(a.annotations ? { annotations: a.annotations } : {}) } : null,
        risk: a.risk,
        status: "pending",
        decision: null,
        createdAt: ts(),
        expiresAt: new Date(Date.now() + bot.policy.approvalTimeoutMinutes * 60_000).toISOString(),
      };
      this.approvals.push(approval);
      run.status = "waiting_approval";
      emit({
        type: "approval.requested",
        approvalId: approval.id,
        toolCall: { toolCallId: id, title: a.title, kind: a.kind, status: "pending", rawInput: a.input },
        options,
        ...(approval.consent ? { consent: approval.consent } : {}),
        policy: { action: "ask", matchedRule: a.rule, risk: a.risk, reason: a.risk >= bot.policy.guardrail.askAbove ? `Clef guardrail risk ${Math.round(a.risk * 100)}% is above the ask threshold` : `Matched rule ${a.rule}` },
        expiresAt: approval.expiresAt,
      });
      this.emitTeam({ kind: "approval", id: approval.id });
      let chosen: string | null;
      if (opts.autoDecide) {
        chosen = options.find((o) => o.kind === (opts.autoDecide === "allow" ? "allow_once" : "reject_once"))?.optionId ?? null;
        approval.status = chosen && opts.autoDecide === "allow" ? "approved" : "denied";
        approval.decision = { optionId: chosen, optionKind: opts.autoDecide === "allow" ? "allow_once" : "reject_once", by: ME.userId, at: ts() };
      } else {
        chosen = await new Promise<string | null>((resolve) => (lr.approval = { id: approval.id, resolve }));
        lr.approval = null;
        opts.fastForwardToApproval = false;
      }
      run.status = "running";
      const opt = options.find((o) => o.optionId === chosen);
      emit({ type: "approval.resolved", approvalId: approval.id, outcome: chosen ? "selected" : "cancelled", ...(opt ? { optionId: opt.optionId, optionKind: opt.kind } : {}), decidedBy: "user", actor: ME.name ?? ME.userId });
      const allowed = Boolean(opt && opt.kind.startsWith("allow"));
      if (!allowed) emit({ type: "tool.update", toolCallId: id, patch: { status: "failed", failureReason: chosen ? "denied" : "cancelled" } });
      return { allowed, toolCallId: id };
    };
    const finishTool = async (id: string, output: string) => {
      emit({ type: "tool.update", toolCallId: id, patch: { status: "in_progress" } });
      await pause(1400);
      emit({ type: "tool.update", toolCallId: id, patch: { status: "completed", rawOutput: { output }, content: [{ type: "content", content: { type: "text", text: output } }] } });
    };

    let answer = "";
    const usage = { inputTokens: 0, outputTokens: 0, credits: 0 };
    try {
      emit({ type: "turn.started", provider: run.provider, ...(run.model ? { model: run.model } : {}), ...(run.engine ? { engine: run.engine, sessionId: `sess_${thread.id.slice(-8)}` } : {}) });
      if (bot.routing.mode === "auto") {
        emit({
          type: "route.decided",
          provider: isFast ? `openai:${bot.routing.fast?.providerId}` : run.provider,
          ...(run.model ? { model: run.model } : {}),
          reason: isFast ? "Conversational question answerable from memory and knowledge; no tools needed" : "Needs tools or the bot computer",
          scores: { needsAgent: isFast ? 0.12 : 0.88 },
        });
      }
      const recalled = this.memories.filter((m) => m.botId === bot.id && !m.supersededBy).slice(0, 3);
      if (recalled.length) emit({ type: "memory.recalled", items: recalled.map((m, i) => ({ id: m.id, content: m.content, kind: m.kind, score: 0.82 - i * 0.11 })) });
      const kbSrc = this.sources.filter((s) => bot.knowledgeBaseIds.includes(s.knowledgeBaseId) && s.status === "ready").slice(0, scenario === "incident" ? 1 : 2);
      if (kbSrc.length && scenario !== "costs") emit({ type: "knowledge.retrieved", items: kbSrc.map((s, i) => ({ chunkId: `chk_${s.id}_${i}`, sourceTitle: s.title, score: 0.74 - i * 0.08, excerpt: s.text.slice(0, 180) })) });
      if (!isFast && bot.primary.kind === "kiro-acp") {
        emit({ type: "mcp.status", servers: [{ name: "orrery", state: "connected", toolCount: 9 }, ...bot.mcpServers.map((m) => ({ name: m.name, state: "connected", toolCount: m.name === "github" ? 41 : 12 }))] });
        emit({ type: "commands.available", commands: [{ name: "compact", description: "Summarize the conversation to free context" }, { name: "model", description: "Switch model", inputHint: "model id" }, { name: "context", description: "Show context usage" }, { name: "tools", description: "List available tools" }] });
        emit({ type: "mode.changed", modeId: (bot.primary as { modeId?: string }).modeId ?? "vibe" });
        emit({ type: "config.changed", options: [{ id: "model", name: "Model", type: "select", currentValue: run.model ?? "auto", options: ["auto", "claude-sonnet-4.5", "claude-haiku-4.5", "claude-opus-4.5"].map((v) => ({ value: v, name: v })) }, { id: "effortLevel", name: "Effort", type: "select", currentValue: (bot.primary as { effort?: string }).effort ?? "medium", options: ["low", "medium", "high"].map((v) => ({ value: v, name: v })) }] });
      } else if (!isFast && bot.primary.kind === "opencode-acp") {
        // OpenCode advertises its agents and models as session config options.
        emit({ type: "commands.available", commands: [{ name: "init", description: "Create or update AGENTS.md" }, { name: "review", description: "Review changes" }, { name: "compact", description: "Summarize the session" }] });
        emit({ type: "config.changed", options: [{ id: "model", name: "Model", type: "select", currentValue: run.model ?? "", options: ["orrery-local-vllm/qwen3-235b-a22b", "orrery-local-vllm/qwen3-30b-a3b", "anthropic/claude-sonnet-4-5"].map((v) => ({ value: v, name: v })) }, { id: "mode", name: "Agent", type: "select", currentValue: bot.primary.modeId ?? "build", options: ["build", "plan"].map((v) => ({ value: v, name: v })) }] });
      }
      await pause(500);

      if (scenario === "quick") {
        answer = await say("API tokens are rate limited **per token**, not per account: 600 requests per minute with bursts up to 100. Limits are listed in the changelog entry for 2.12 and the *Rate limits* page of the product docs.");
        usage.inputTokens = 1840;
        usage.outputTokens = 96;
      } else if (scenario === "incident") {
        const payments = /payments/.test(text.toLowerCase());
        const ns = payments ? "production" : "staging";
        const app = payments ? "payments-gateway" : "api";
        emit({ type: "plan", entries: [
          { content: `Check ${app} pods and recent events in ${ns}`, priority: "high", status: "in_progress" },
          { content: "Read logs from the failing pods", priority: "high", status: "pending" },
          { content: "Compare with the last deployment", priority: "medium", status: "pending" },
          { content: "Fix and verify", priority: "medium", status: "pending" },
        ] });
        await think(`The alert points at ${app} in ${ns}. Memory says to read state before changing it, and the runbook says 502s usually mean readiness failures. Start with pods and events.`);
        await tool({ title: `kubectl get pods -n ${ns} -l app=${app}`, kind: "execute", input: { command: `kubectl get pods -n ${ns} -l app=${app} -o wide` }, output: `NAME                         READY   STATUS             RESTARTS      AGE\n${app}-7d9f6c8b5-2kq8x   0/1     CrashLoopBackOff   6 (41s ago)   14m\n${app}-7d9f6c8b5-h7ttm   0/1     CrashLoopBackOff   6 (38s ago)   14m\n${app}-6b8c9d7f4-x9z2p   1/1     Running            0             2d`, terminal: true });
        emit({ type: "plan", entries: [
          { content: `Check ${app} pods and recent events in ${ns}`, priority: "high", status: "completed" },
          { content: "Read logs from the failing pods", priority: "high", status: "in_progress" },
          { content: "Compare with the last deployment", priority: "medium", status: "pending" },
          { content: "Fix and verify", priority: "medium", status: "pending" },
        ] });
        await tool({ title: `kubectl logs ${app}-7d9f6c8b5-2kq8x -n ${ns} --tail=40`, kind: "execute", input: { command: `kubectl logs ${app}-7d9f6c8b5-2kq8x -n ${ns} --tail=40` }, output: `{"level":"info","msg":"loading config","file":"/etc/${app}/config.yaml"}\n{"level":"fatal","msg":"invalid config: upstream.timeout must be a duration","value":"30"}`, terminal: true });
        await tool({ title: `Read deploy/${app}/values.yaml`, kind: "read", input: { path: `deploy/${app}/values.yaml` }, locations: [{ path: `deploy/${app}/values.yaml`, line: 42 }], output: `upstream:\n  url: http://ledger.internal:8080\n  timeout: 30   # changed in #1482` });
        emit({ type: "plan", entries: [
          { content: `Check ${app} pods and recent events in ${ns}`, priority: "high", status: "completed" },
          { content: "Read logs from the failing pods", priority: "high", status: "completed" },
          { content: "Compare with the last deployment", priority: "medium", status: "completed" },
          { content: "Fix and verify", priority: "medium", status: "in_progress" },
        ] });
        await tool({ title: `Edit deploy/${app}/values.yaml`, kind: "edit", input: { path: `deploy/${app}/values.yaml` }, locations: [{ path: `deploy/${app}/values.yaml`, line: 42 }], output: "", diff: { path: `deploy/${app}/values.yaml`, oldText: "  timeout: 30   # changed in #1482", newText: "  timeout: 30s" } });
        emit({ type: "usage", usage: { contextPercent: 18, contextUsedTokens: 36_400, contextWindowTokens: 200_000 } });
        const restart = await ask({
          title: `kubectl rollout restart deploy/${app} -n ${ns}`,
          kind: "execute",
          input: { command: `kubectl rollout restart deploy/${app} -n ${ns}` },
          resource: `kubectl rollout restart deploy/${app} -n ${ns}`,
          capability: "shell",
          rule: "ask-kubectl-mutations",
          risk: payments ? 0.71 : 0.58,
        });
        if (restart.allowed) {
          await finishTool(restart.toolCallId, `deployment.apps/${app} restarted`);
          await tool({ title: `kubectl rollout status deploy/${app} -n ${ns}`, kind: "execute", input: { command: `kubectl rollout status deploy/${app} -n ${ns} --timeout=120s` }, output: `Waiting for deployment "${app}" rollout to finish: 1 of 2 updated replicas are available...\ndeployment "${app}" successfully rolled out`, terminal: true, ms: 1500 });
          emit({ type: "plan", entries: [
            { content: `Check ${app} pods and recent events in ${ns}`, priority: "high", status: "completed" },
            { content: "Read logs from the failing pods", priority: "high", status: "completed" },
            { content: "Compare with the last deployment", priority: "medium", status: "completed" },
            { content: "Fix and verify", priority: "medium", status: "completed" },
          ] });
          answer = await say(
            `**What's wrong.** The new ${app} pods crash on start: \`upstream.timeout\` was changed to a bare number (\`30\`) in #1482, and the config loader requires a duration.\n\n**Evidence.** Two pods in CrashLoopBackOff with \`invalid config: upstream.timeout must be a duration\`; the old ReplicaSet pod is still serving, which explains the intermittent 502s.\n\n**What I did.** Changed it to \`30s\` in \`deploy/${app}/values.yaml\` and restarted the deployment. The rollout finished and both replicas are ready.\n\n**Next.** The fix is only on the bot computer's checkout — I can open a PR against #1482 so it doesn't come back with the next sync.${steered ? "\n\nI also took your note into account while checking." : ""}`,
          );
        } else {
          answer = await say(`Understood — I didn't restart anything. The fix is ready in \`deploy/${app}/values.yaml\` (\`timeout: 30\` → \`30s\`). The crashing pods come from #1482; the old ReplicaSet is still serving traffic, so you're seeing intermittent 502s rather than a full outage. Tell me when to roll it out, or I can open a PR instead.`);
        }
        usage.inputTokens = 48_200;
        usage.outputTokens = 2_150;
        usage.credits = payments ? 0.61 : 0.47;
        const fact = `${app}'s config loader requires durations with units (e.g. 30s); a bare number crashes the pods.`;
        const mem = this.addMemory(bot.id, "fact", fact, 0.7, { type: "turn", runId: run.id, threadId: thread.id });
        emit({ type: "memory.written", items: [{ id: mem.id, content: fact, kind: "fact", action: "created" }] });
      } else if (scenario === "research") {
        await tool({ title: "kubectl get pods -A --field-selector=status.phase!=Running", kind: "execute", input: { command: "kubectl get pods -A --field-selector=status.phase!=Running" }, output: "NAMESPACE   NAME                      READY   STATUS      RESTARTS   AGE\nbatch       report-28411200-7xk2p     0/1     Completed   0          3h", terminal: true });
        await tool({ title: "kubectl get pvc -A | grep Pending", kind: "execute", input: { command: "kubectl get pvc -A | grep Pending" }, output: "(no output)", terminal: true });
        await tool({ title: "memory_search", kind: "other", identity: { source: "platform", server: "orrery", tool: "memory_search" }, input: { query: "certificate expiry" }, output: "No relevant memories." });
        await tool({ title: "Search certificates expiring within 14 days", kind: "search", input: { query: "certificates notAfter < now+14d" }, output: "staging/wildcard-tls expires in 9 days (cert-manager renewal scheduled)" });
        answer = await say("All clear on both clusters, with one item to watch:\n\n- No failing pods (one completed batch job in `batch`).\n- No pending PVCs.\n- `staging/wildcard-tls` expires in 9 days; cert-manager has a renewal scheduled for tomorrow 03:00.\n\nI'll check the renewal in tomorrow's run.");
        usage.inputTokens = 21_400;
        usage.outputTokens = 610;
        usage.credits = 0.18;
      } else if (scenario === "docs") {
        emit({ type: "plan", entries: [
          { content: "Find the broken links", priority: "high", status: "in_progress" },
          { content: "Fix them in docs/", priority: "high", status: "pending" },
          { content: "Open a pull request", priority: "medium", status: "pending" },
        ] });
        await tool({ title: "npm run docs:check-links", kind: "execute", input: { command: "npm run docs:check-links" }, output: "✗ docs/guides/tokens.md → /reference/limits (404)\n✗ docs/guides/webhooks.md → /reference/events#retry (missing anchor)\n✗ docs/index.md → https://status.northwind.example (timeout)", terminal: true });
        await tool({ title: "Edit docs/guides/tokens.md", kind: "edit", input: { path: "docs/guides/tokens.md" }, locations: [{ path: "docs/guides/tokens.md", line: 18 }], output: "", diff: { path: "docs/guides/tokens.md", oldText: "See [limits](/reference/limits).", newText: "See [rate limits](/reference/rate-limits)." } });
        await tool({ title: "Edit docs/guides/webhooks.md", kind: "edit", input: { path: "docs/guides/webhooks.md" }, locations: [{ path: "docs/guides/webhooks.md", line: 64 }], output: "", diff: { path: "docs/guides/webhooks.md", oldText: "[retries](/reference/events#retry)", newText: "[retries](/reference/events#retries)" } });
        emit({ type: "plan", entries: [
          { content: "Find the broken links", priority: "high", status: "completed" },
          { content: "Fix them in docs/", priority: "high", status: "completed" },
          { content: "Open a pull request", priority: "medium", status: "in_progress" },
        ] });
        if (bot.id === "bot_quill") {
          answer = await say("Draft for **2.14**:\n\n- API: Rate limits now apply per token instead of per account.\n- Dashboard: New usage view with daily credits per bot.\n- Webhooks: Retries use exponential backoff up to 24 hours.\n\nI left out #1490 (internal refactor). Want it under *Internal*?");
          usage.inputTokens = 15_800;
          usage.outputTokens = 780;
          usage.credits = 0.2;
        } else {
          const pr = await ask({
            title: "github / create_pull_request",
            kind: "other",
            input: { owner: "northwind", repo: "web", title: "docs: fix broken links in guides", head: "scout/fix-docs-links", base: "main" },
            resource: "github/create_pull_request",
            capability: "mcp",
            rule: "default (ask)",
            risk: 0.34,
            identity: { source: "mcp", server: "github", tool: "create_pull_request" },
            annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
          });
          if (pr.allowed) {
            await finishTool(pr.toolCallId, "Created pull request northwind/web#1503");
            answer = await say("Fixed 2 of 3 links and opened **northwind/web#1503**. The third (`status.northwind.example`) timed out from the bot computer — it isn't on the egress allowlist, so I left it unchanged.");
          } else {
            answer = await say("No PR opened. The two link fixes are committed on `scout/fix-docs-links` in the bot computer if you want to push it yourself.");
          }
          usage.inputTokens = 19_300;
          usage.outputTokens = 540;
          usage.credits = 0.22;
        }
      } else {
        await tool({ title: "query_cost_explorer", kind: "fetch", identity: { source: "mcp", server: "aws-billing", tool: "get_cost_and_usage" }, input: { granularity: "MONTHLY", groupBy: "SERVICE", period: "2026-09-01/2026-11-01" }, output: "EC2 €7,210 (+4%) · EKS €1,460 (+0%) · NAT Gateway €2,980 (+61%) · S3 €1,120 (+3%) · RDS €3,050 (+1%)" });
        answer = await say("October came in at **€15,820**, up 9% on September. Nearly all of it is **NAT Gateway (+€1,130, +61%)**: data processing charges rose after the batch reporting jobs started pulling from S3 through the NAT instead of the S3 gateway endpoint.\n\nAdding an S3 gateway endpoint to the batch subnets would remove most of that — roughly €1,000 a month.");
        usage.inputTokens = 6_900;
        usage.outputTokens = 420;
      }

      const u = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.inputTokens + usage.outputTokens, ...(usage.credits ? { metering: { credits: usage.credits } } : {}), ...(run.provider === "openai" ? { costUsd: +(usage.inputTokens * 0.0000002 + usage.outputTokens * 0.0000006).toFixed(4) } : {}), contextPercent: isFast ? undefined : Math.min(64, Math.round(usage.inputTokens / 2000)), turnDurationMs: instant ? 38_000 : Date.now() - Date.parse(run.startedAt) } as Run["usage"];
      // context gauge streams as `usage`; token and credit totals arrive once, with the prompt response
      if (u.contextPercent !== undefined) emit({ type: "usage", usage: { contextPercent: u.contextPercent } });
      emit({ type: "turn.completed", stopReason: "end_turn", usage: u });
      run.status = "completed";
      run.stopReason = "end_turn";
      run.usage = u;
    } catch (e) {
      if (e instanceof Cancelled) {
        emit({ type: "turn.completed", stopReason: "cancelled" });
        run.status = "cancelled";
        run.stopReason = "cancelled";
        for (const a of this.approvals) if (a.runId === run.id && a.status === "pending") a.status = "cancelled";
      } else {
        emit({ type: "turn.failed", error: { code: "internal", message: String(e), retryable: false } });
        run.status = "failed";
      }
    } finally {
      run.endedAt = ts();
      this.live.delete(run.id);
    }
    if (answer) this.messages.push({ id: uid("msg"), threadId: thread.id, role: "assistant", author: { type: "bot", id: bot.id, name: bot.name }, parts: [{ type: "text", text: answer }], runId: run.id, createdAt: ts() });
    if (!instant) this.emitTeam({ kind: "run_event", runId: run.id, threadId: thread.id, seq });
    return run;
  }

  private addMemory(botId: string, kind: MemoryItem["kind"], content: string, importance: number, source: MemoryItem["source"]): MemoryItem {
    const m: MemoryItem = { id: uid("mem"), teamId: TEAM, botId, userId: null, scope: "bot", kind, content, tags: [], importance, confidence: 0.85, pinned: false, source, validFrom: now(), validTo: null, supersededBy: null, accessCount: 0, lastAccessedAt: null, createdAt: now(), updatedAt: now() };
    this.memories.unshift(m);
    return m;
  }

  private botOr404(id: string): Bot {
    const b = this.bots.find((x) => x.id === id);
    if (!b) throw new ApiError(404, "not_found", "bot not found");
    return b;
  }

  /* ----------------------------------------------------------------------- API */

  me = async () => ME;
  listBots = async () => clone(this.bots.filter((b) => b.status !== "archived"));
  getBot = async (id: string) => {
    const bot = this.botOr404(id);
    const running: Record<string, string> = {};
    for (const l of this.live.values()) if (l.run.botId === id) running[l.run.threadId] = l.run.id;
    return { bot: clone(bot), state: { botId: id, paused: bot.status === "paused", queued: 0, running } satisfies BotState };
  };
  createBot = async (input: BotCreate) => {
    const bot = { ...seedBots()[0]!, ...(input as Partial<Bot>), id: uid("bot"), teamId: TEAM, status: "active", createdAt: now(), updatedAt: now() } as Bot;
    if (!bot.policy.rules.length) bot.policy = basePolicy();
    this.bots.push(bot);
    this.core[bot.id] = { persona: bot.instructions, human: "", notes: "" };
    this.audit_("bot.create", bot.id, { name: bot.name });
    return clone(bot);
  };
  updateBot = async (id: string, patch: Partial<BotCreate> & { status?: Bot["status"] }) => {
    const b = this.botOr404(id);
    Object.assign(b, patch, { updatedAt: now() });
    this.audit_("bot.update", id, { fields: Object.keys(patch) });
    return clone(b);
  };
  archiveBot = async (id: string) => {
    this.botOr404(id).status = "archived";
    this.audit_("bot.archive", id);
  };

  listThreads = async (botId: string) => clone(this.threads.filter((t) => t.botId === botId && !t.archived).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)));
  createThread = async (botId: string, title?: string) => clone(this.mkThread(botId, title ?? "New conversation", "web", 0));
  archiveThread = async (id: string) => {
    const t = this.threads.find((x) => x.id === id);
    if (t) t.archived = true;
  };
  listMessages = async (threadId: string) => clone(this.messages.filter((m) => m.threadId === threadId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  sendMessage: OrreryApi["sendMessage"] = async (threadId, body) => {
    const t = this.threads.find((x) => x.id === threadId);
    if (!t) throw new ApiError(404, "not_found", "thread not found");
    const bot = this.botOr404(t.botId);
    if (bot.status === "paused") throw new ApiError(409, "conflict", `${bot.name} is paused. Resume the bot to send messages.`);
    const active = [...this.live.values()].find((l) => l.run.threadId === threadId);
    const msg: Message = { id: uid("msg"), threadId, role: "user", author: { type: "user", id: ME.userId, name: ME.name ?? "You" }, parts: [{ type: "text", text: body.text }], createdAt: now(), ...(active && body.mode === "steer" ? { runId: active.run.id, meta: { steered: true } } : {}) };
    this.messages.push(msg);
    if (t.title === "New conversation") t.title = body.text.slice(0, 60);
    // Like the API: agents that cannot be steered get the message as the next turn.
    const steerable = (bot.primary.kind === "kiro-acp" || bot.primary.kind === "acp") && active?.run.provider !== "openai";
    if (active && body.mode === "steer" && !steerable) {
      msg.runId = undefined;
      msg.meta = undefined;
    }
    if (active && body.mode === "steer" && steerable) {
      active.steer.push(body.text);
      active.emit({ type: "steering", status: "queued", text: body.text });
      return { messageId: msg.id, threadId, mode: "steer", runId: active.run.id };
    }
    const start = () => void this.simulate(t, body.text, null, { existingMessageId: msg.id });
    if (active) {
      // one turn per thread: queue behind the active run
      const timer = setInterval(() => {
        if (![...this.live.values()].some((l) => l.run.threadId === threadId)) {
          clearInterval(timer);
          start();
        }
      }, 300);
    } else start();
    return { messageId: msg.id, threadId, mode: "queue" };
  };

  listRuns = async (threadId: string) => clone(this.runs.filter((r) => r.threadId === threadId));
  activeRuns = async () => clone([...this.live.values()].map((l) => l.run));
  getRun = async (id: string) => {
    const run = this.runs.find((r) => r.id === id);
    if (!run) throw new ApiError(404, "not_found", "run not found");
    return { run: clone(run), traceUrl: `https://langfuse.northwind.example/project/orrery/traces/${run.traceId}` };
  };
  runEvents = async (id: string) => clone(this.events.filter((e) => e.runId === id));
  cancelRun = async (id: string) => {
    const l = this.live.get(id);
    if (!l) return;
    l.cancelled = true;
    l.approval?.resolve(null);
  };
  feedback = async (id: string, value: number) => this.audit_("run.feedback", id, { value });
  streamThread: OrreryApi["streamThread"] = (threadId, onEvent, onState) => {
    onState?.("connecting");
    let set = this.threadSubs.get(threadId);
    if (!set) this.threadSubs.set(threadId, (set = new Set()));
    const fn = (e: RunEventEnvelope) => onEvent(clone(e));
    set.add(fn);
    queueMicrotask(() => {
      for (const e of this.events.filter((x) => x.threadId === threadId)) onEvent(clone(e));
      onState?.("open");
    });
    return () => set!.delete(fn);
  };
  streamTeam: OrreryApi["streamTeam"] = (onNotice) => {
    this.teamSubs.add(onNotice);
    return () => this.teamSubs.delete(onNotice);
  };

  listApprovals = async (botId?: string) => clone(this.approvals.filter((a) => a.status === "pending" && (!botId || a.botId === botId)));
  decideApproval: OrreryApi["decideApproval"] = async (id, d) => {
    const a = this.approvals.find((x) => x.id === id);
    if (!a) throw new ApiError(404, "not_found", "approval not found");
    if (a.status !== "pending") throw new ApiError(409, "conflict", `This request was already ${a.status}.`);
    const opt = d.optionId ? a.options.find((o) => o.optionId === d.optionId) : undefined;
    if (!d.cancel && !opt) throw new ApiError(400, "bad_request", "choose one of the offered options");
    a.status = d.cancel ? "cancelled" : opt!.kind.startsWith("allow") ? "approved" : "denied";
    a.decision = { optionId: opt?.optionId ?? null, optionKind: opt?.kind ?? null, persist: d.persist ?? null, by: ME.userId, at: now(), note: d.note ?? null };
    this.audit_("approval.decide", id, { status: a.status, option: opt?.kind ?? null, resource: a.resource });
    this.live.get(a.runId)?.approval?.resolve(d.cancel ? null : opt!.optionId);
    this.emitTeam({ kind: "approval", id });
    return clone(a);
  };

  coreMemory = async (botId: string) => clone(this.core[botId] ?? { persona: "", human: "", notes: "" });
  setCoreMemory: OrreryApi["setCoreMemory"] = async (botId, block, content) => {
    const limit = this.botOr404(botId).memory.coreMemoryCharLimit;
    if (content.length > limit) throw new ApiError(400, "bad_request", `Core memory blocks are limited to ${limit} characters.`);
    (this.core[botId] ??= { persona: "", human: "", notes: "" })[block] = content;
  };
  listMemories: OrreryApi["listMemories"] = async (q) =>
    clone(
      this.memories.filter(
        (m) => (!q.botId || m.botId === q.botId || (m.botId === null && m.scope === "team")) && (!q.kind || m.kind === q.kind) && (q.includeSuperseded || !m.supersededBy) && (!q.q || m.content.toLowerCase().includes(q.q.toLowerCase())),
      ),
    );
  writeMemory: OrreryApi["writeMemory"] = async (botId, w): Promise<WriteOutcome> => {
    if (/\b(?:password|passwd|secret|api[_ -]?key|token)\s+(?:is|=|:)\s+\S*\d\S*/i.test(w.content) || /\b(?:sk|ghp|glpat|xox[abpr])[-_][A-Za-z0-9_-]{16,}/.test(w.content)) return { action: "skipped", reason: "sensitive", content: w.content };
    const dup = this.memories.find((m) => m.botId === botId && !m.supersededBy && similarity(m.content, w.content) > 0.8);
    if (dup) {
      dup.updatedAt = now();
      return { action: "updated", reason: "duplicate", id: dup.id, content: dup.content };
    }
    const m = this.addMemory(botId, w.kind, w.content, w.importance ?? 0.5, { type: "user" });
    m.pinned = Boolean(w.pinned);
    this.audit_("memory.write", m.id);
    return { action: "created", reason: "new", id: m.id, content: m.content };
  };
  updateMemory: OrreryApi["updateMemory"] = async (id, patch) => {
    const m = this.memories.find((x) => x.id === id);
    if (!m) throw new ApiError(404, "not_found", "memory not found");
    Object.assign(m, patch, { updatedAt: now() });
    return clone(m);
  };
  forgetMemory = async (id: string) => {
    this.memories = this.memories.filter((m) => m.id !== id);
    this.audit_("memory.forget", id);
  };
  recall: OrreryApi["recall"] = async (botId, query) =>
    this.memories
      .filter((m) => (m.botId === botId || m.scope === "team") && !m.supersededBy)
      .map((m) => ({ id: m.id, kind: m.kind, content: m.content, score: +(similarity(m.content, query) * 0.7 + m.importance * 0.3).toFixed(3) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  consolidate = async (botId: string) => {
    this.audit_("memory.consolidate", botId);
    await wait(600);
  };

  listKnowledgeBases = async () => clone(this.kbs);
  createKnowledgeBase: OrreryApi["createKnowledgeBase"] = async (k) => {
    const kb: KnowledgeBase = { id: uid("kb"), teamId: TEAM, name: k.name, description: k.description, embeddingModel: "bge-m3", embeddingDims: 1024, chunkSize: 1200, chunkOverlap: 150, createdAt: now() };
    this.kbs.push(kb);
    return clone(kb);
  };
  listSources = async (kbId: string) => clone(this.sources.filter((s) => s.knowledgeBaseId === kbId)).map(({ text: _t, ...s }) => s);
  addSource: OrreryApi["addSource"] = async (kbId, s) => {
    const text = s.type === "text" ? s.text : s.type === "upload" ? await s.file.text().catch(() => "") : `Content fetched from ${s.uri}`;
    const src = { id: uid("src"), knowledgeBaseId: kbId, type: s.type, uri: s.type === "url" ? s.uri : s.type === "upload" ? s.file.name : `text:${s.title}`, title: s.type === "upload" ? s.file.name : (s.title ?? (s as { uri: string }).uri), mimeType: s.type === "upload" ? s.file.type || null : "text/markdown", status: "pending" as const, error: null, stats: {}, createdAt: now(), updatedAt: now(), text } as KnowledgeSource & { text: string };
    this.sources.push(src);
    setTimeout(() => (src.status = "ingesting"), 600);
    setTimeout(() => {
      src.status = "ready";
      src.stats = { chunks: Math.max(1, Math.ceil(text.length / 1100)), rejected: 0, bytes: text.length };
      src.updatedAt = now();
    }, 2400);
    const { text: _t, ...out } = src;
    return clone(out);
  };
  deleteSource = async (id: string) => void (this.sources = this.sources.filter((s) => s.id !== id));
  reingest = async (id: string) => {
    const s = this.sources.find((x) => x.id === id);
    if (!s) return;
    s.status = "ingesting";
    s.error = null;
    setTimeout(() => {
      s.status = s.text ? "ready" : "failed";
      s.error = s.text ? null : "Fetch failed: host not on the egress allowlist";
    }, 1800);
  };
  searchKnowledge: OrreryApi["searchKnowledge"] = async (kbIds, query) => {
    const hits = this.sources
      .filter((s) => kbIds.includes(s.knowledgeBaseId) && s.status === "ready")
      .flatMap((s) => s.text.split(/(?<=\.)\s+/).map((sentence, i) => ({ chunkId: `${s.id}_${i}`, sourceId: s.id, sourceTitle: s.title, uri: s.uri, heading: null, content: sentence, score: similarity(sentence, query) })))
      .filter((h) => h.score > 0.05)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
    return { hits, sufficient: hits.length ? (hits[0]!.score > 0.2 ? true : false) : null };
  };

  listRoutines = async (botId?: string) => clone(this.routines.filter((r) => !botId || r.botId === botId));
  createRoutine: OrreryApi["createRoutine"] = async (r) => {
    const out: Routine = { ...r, id: uid("rtn"), teamId: TEAM, threadId: null, lastRunAt: null, createdAt: now() };
    this.routines.push(out);
    this.audit_("routine.create", out.id);
    return clone(out);
  };
  updateRoutine: OrreryApi["updateRoutine"] = async (id, p) => {
    const r = this.routines.find((x) => x.id === id);
    if (!r) throw new ApiError(404, "not_found", "routine not found");
    Object.assign(r, p);
    return clone(r);
  };
  deleteRoutine = async (id: string) => void (this.routines = this.routines.filter((r) => r.id !== id));
  runRoutine = async (id: string) => {
    const r = this.routines.find((x) => x.id === id);
    if (!r) return;
    let t = r.threadPolicy === "reuse" && r.threadId ? this.threads.find((x) => x.id === r.threadId) : undefined;
    if (!t) t = this.mkThread(r.botId, r.name, "routine", 0);
    r.threadId = t.id;
    r.lastRunAt = now();
    void this.simulate(t, r.prompt, null, { author: { type: "system", id: `routine:${r.id}`, name: r.name } });
  };

  providers = async () => ({
    providers: [
      { id: "local-vllm", kind: "openai", roles: ["chat", "fast", "extract", "summarize"], models: { chat: ["qwen3-235b-a22b", "qwen3-30b-a3b"] } },
      { id: "tei", kind: "openai", roles: ["embed", "rerank"], models: { chat: [], embed: "bge-m3", rerank: "bge-reranker-v2-m3" } },
      { id: "clef", kind: "clef", roles: ["decide"], models: { model: "@cf/cloudflare/clef", fastModel: "@cf/cloudflare/clef-flash" } },
    ],
    decisions: "clef",
  });
  testProvider = async (id: string) => {
    await wait(400 + Math.random() * 500);
    return { ok: id !== "missing", latencyMs: Math.round(80 + Math.random() * 240) };
  };
  usage = async (): Promise<UsageRow[]> => [
    { botId: "bot_ada", provider: "kiro-acp", runs: 184, inputTokens: 6_120_000, outputTokens: 288_000, credits: 61.4, costUsd: 0 },
    { botId: "bot_scout", provider: "kiro-acp", runs: 97, inputTokens: 2_480_000, outputTokens: 101_000, credits: 22.8, costUsd: 0 },
    { botId: "bot_scout", provider: "openai", runs: 412, inputTokens: 760_000, outputTokens: 92_000, credits: 0, costUsd: 0.21 },
    { botId: "bot_quill", provider: "kiro-acp", runs: 38, inputTokens: 980_000, outputTokens: 64_000, credits: 9.1, costUsd: 0 },
    { botId: "bot_patch", provider: "opencode-acp", runs: 64, inputTokens: 3_150_000, outputTokens: 142_000, credits: 0, costUsd: 0 },
    { botId: "bot_ledger", provider: "openai", runs: 22, inputTokens: 310_000, outputTokens: 28_000, credits: 0, costUsd: 0.08 },
  ];
  computers = async (): Promise<ComputerRow[]> => [
    { id: "cmp_bot_ada", teamId: TEAM, botId: "bot_ada", provider: "kubernetes", status: "ready", endpoint: "ws://orrery-cmp-bot-ada.orrery-computers.svc:7777/acp", agentKind: "kiro-v3", lastActiveAt: ago(1) },
    { id: "cmp_bot_scout", teamId: TEAM, botId: "bot_scout", provider: "kubernetes", status: "ready", endpoint: "ws://orrery-cmp-bot-scout.orrery-computers.svc:7777/acp", agentKind: "kiro-auto", lastActiveAt: ago(4) },
    { id: "cmp_bot_quill", teamId: TEAM, botId: "bot_quill", provider: "kubernetes", status: "stopped", endpoint: null, agentKind: "kiro-v2", lastActiveAt: ago(60 * 5) },
    { id: "cmp_bot_patch", teamId: TEAM, botId: "bot_patch", provider: "kubernetes", status: "ready", endpoint: "ws://orrery-cmp-bot-patch.orrery-computers.svc:7777/acp", agentKind: "opencode", lastActiveAt: ago(9) },
  ];
  audit = async () => clone(this.auditLog);
  listSecrets = async () => clone(this.secrets);
  putSecret = async (name: string) => {
    if (!this.secrets.some((s) => s.name === name)) this.secrets.push({ name, createdAt: now() });
    this.audit_("secret.put", name);
  };
  deleteSecret = async (name: string) => {
    this.secrets = this.secrets.filter((s) => s.name !== name);
    this.audit_("secret.delete", name);
  };
  webhookToken = async (botId: string) => ({ token: `whk_${botId}_${Math.random().toString(36).slice(2, 14)}`, url: `https://orrery.northwind.example/v1/hooks/bots/${botId}` });
}

class Cancelled extends Error {}

function similarity(a: string, b: string): number {
  const tok = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9äöå]{3,}/g) ?? []);
  const x = tok(a);
  const y = tok(b);
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const t of y) if (x.has(t)) n++;
  return n / Math.min(x.size, y.size);
}
