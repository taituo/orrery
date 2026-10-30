import { createInterface, type Interface } from "node:readline/promises";
import type { OrreryClient } from "./client.js";
import { style, type Io } from "./io.js";

interface RunEventEnvelope {
  runId: string;
  threadId: string;
  botId: string;
  seq: number;
  event: Record<string, unknown> & { type: string };
}

interface ApprovalOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface ChatTarget {
  threadId: string;
  /** Display name of the conversation (bot or group). */
  title: string;
  /** Bot names by id (groups have several). */
  botNames: Map<string, string>;
}

export interface ChatOptions {
  /** Approve tool calls automatically with the agent's one-time option (non-interactive use). */
  approve?: boolean;
  showThoughts?: boolean;
  json?: boolean;
}

/**
 * One conversation turn (or an interactive session) against a thread: subscribes to the
 * thread's event stream, sends the message, renders the reply as it streams, and asks about
 * tool approvals inline.
 */
export class ChatSession {
  private readonly abort = new AbortController();
  private readonly knownRuns = new Set<string>();
  private readonly active = new Map<string, { bot: string; printedHeader: boolean }>();
  private readonly waiters: Array<{ resolve: (ok: boolean) => void }> = [];
  private ready!: Promise<void>;
  private rl: Interface | null = null;
  private lastStream: string | null = null;
  private atLineStart = true;
  private failed = false;
  private pendingApprovals = new Map<string, { title: string; options: ApprovalOption[] }>();

  constructor(
    private readonly client: OrreryClient,
    private readonly io: Io,
    private readonly target: ChatTarget,
    private readonly opts: ChatOptions = {},
  ) {}

  async start(): Promise<void> {
    const { runs } = await this.client.get<{ runs: Array<{ id: string }> }>(`/v1/threads/${this.target.threadId}/runs`);
    for (const r of runs) this.knownRuns.add(r.id);
    let readyResolve!: () => void;
    this.ready = new Promise<void>((r) => (readyResolve = r));
    void this.client
      .stream(
        `/v1/threads/${this.target.threadId}/events`,
        async (e) => {
          if (e.event !== "run_event") return;
          await this.onEvent(JSON.parse(e.data) as RunEventEnvelope);
        },
        this.abort.signal,
        readyResolve,
      )
      .catch((err: unknown) => {
        this.io.err(style.red(`stream error: ${(err as Error).message}`));
        readyResolve();
      });
    await Promise.race([this.ready, new Promise((r) => setTimeout(r, 10_000))]);
  }

  stop(): void {
    this.abort.abort();
    this.rl?.close();
  }

  /** Send a message and wait until the turn(s) it started finish. Returns false when a turn failed. */
  async send(text: string, mode: "queue" | "steer" = "queue"): Promise<boolean> {
    this.failed = false;
    const done = new Promise<boolean>((resolve) => this.waiters.push({ resolve }));
    const r = await this.client.post<{ mode: string; runId?: string }>(`/v1/threads/${this.target.threadId}/messages`, { text, mode });
    if (r.mode === "steer") {
      this.io.out(style.dim("  ↳ steering sent to the running turn"));
      this.waiters.pop();
      return true;
    }
    return done;
  }

  /** Interactive loop: each line is a message; /help lists commands. */
  async repl(): Promise<void> {
    const rl = createInterface({ input: this.io.stdin, output: this.io.stdout, terminal: this.io.isTTY });
    this.rl = rl;
    this.io.out(style.dim(`Talking to ${this.target.title}. /help for commands, Ctrl+D to leave.`));
    let interrupted = false;
    rl.on("SIGINT", () => {
      const running = [...this.active.keys()];
      if (running.length && !interrupted) {
        interrupted = true;
        this.io.out(style.yellow("\n  stopping the turn… (Ctrl+C again to leave)"));
        for (const id of running) void this.client.post(`/v1/runs/${id}/cancel`).catch(() => undefined);
        return;
      }
      rl.close();
    });
    for (;;) {
      let line: string;
      try {
        line = (await rl.question(style.bold("you › "))).trim();
      } catch {
        break; // closed (Ctrl+D)
      }
      interrupted = false;
      if (!line) continue;
      if (line === "/exit" || line === "/quit") break;
      if (line === "/help") {
        this.io.out(["  /steer <text>   guide the running turn (queued next if the agent can't be steered)", "  /cancel         stop the running turn", "  /exit           leave"].join("\n"));
        continue;
      }
      if (line === "/cancel") {
        for (const id of this.active.keys()) await this.client.post(`/v1/runs/${id}/cancel`).catch(() => undefined);
        continue;
      }
      if (line.startsWith("/steer ")) {
        await this.send(line.slice(7), "steer").catch((e: Error) => this.io.err(style.red(e.message)));
        continue;
      }
      await this.send(line).catch((e: Error) => this.io.err(style.red(e.message)));
    }
    rl.close();
    this.rl = null;
  }

  private write(s: string): void {
    this.io.write(s);
    if (s.length) this.atLineStart = s.endsWith("\n");
  }

  private newline(): void {
    if (!this.atLineStart) this.write("\n");
  }

  private async onEvent(env: RunEventEnvelope): Promise<void> {
    if (this.knownRuns.has(env.runId)) return;
    const e = env.event;
    if (this.opts.json) this.io.out(JSON.stringify(env));
    const name = this.target.botNames.get(env.botId) ?? "bot";
    let run = this.active.get(env.runId);
    if (!run) {
      run = { bot: name, printedHeader: false };
      this.active.set(env.runId, run);
    }
    if (this.opts.json) {
      if (e.type === "approval.requested") await this.approval(e);
      if (e.type === "turn.completed" || e.type === "turn.failed" || e.type === "turn.interrupted") this.finish(env.runId, e.type === "turn.completed");
      return;
    }
    const header = () => {
      if (run.printedHeader && this.lastStream === env.runId) return;
      this.newline();
      this.write(`${style.bold(style.accent(run.bot))} ${style.dim("›")} `);
      run.printedHeader = true;
      this.lastStream = env.runId;
    };
    switch (e.type) {
      case "message.delta": {
        const part = e.part as { type?: string; text?: string } | undefined;
        if (part?.type === "text" && part.text) {
          header();
          this.write(part.text);
        }
        break;
      }
      case "thought.delta": {
        const part = e.part as { text?: string } | undefined;
        if (this.opts.showThoughts && part?.text) {
          header();
          this.write(style.dim(part.text));
        }
        break;
      }
      case "tool.call": {
        const call = e.call as { title?: string; kind?: string };
        this.newline();
        this.write(style.dim(`  ⚙ ${call.title ?? call.kind ?? "tool"}\n`));
        this.lastStream = null;
        break;
      }
      case "tool.update": {
        if (e.status === "failed") {
          this.newline();
          this.write(style.red(`  ✗ ${(e.title as string | undefined) ?? "tool failed"}${e.failureReason ? ` (${String(e.failureReason)})` : ""}\n`));
          this.lastStream = null;
        }
        break;
      }
      case "approval.requested":
        this.newline();
        this.lastStream = null;
        await this.approval(e);
        break;
      case "approval.resolved":
        if (this.pendingApprovals.delete(String(e.approvalId)) && e.decidedBy !== "user") this.write(style.dim(`  approval ${String(e.outcome)} (${String(e.decidedBy)})\n`));
        break;
      case "notice":
        this.newline();
        this.write(style.yellow(`  ! ${String(e.title)}${e.message ? ` — ${String(e.message)}` : ""}\n`));
        this.lastStream = null;
        break;
      case "auth.required":
        this.newline();
        this.write(style.red(`  ! ${String(e.message ?? "the agent needs credentials")}\n`));
        break;
      case "delegation.started":
      case "handoff":
        this.newline();
        this.write(style.dim(`  → ${String(e.title ?? e.toBotName ?? "handed off")}\n`));
        break;
      case "turn.completed":
        this.newline();
        this.finish(env.runId, true);
        break;
      case "turn.failed": {
        const err = e.error as { message?: string } | undefined;
        this.newline();
        this.write(style.red(`  ✗ ${name}: ${err?.message ?? "turn failed"}\n`));
        this.finish(env.runId, false);
        break;
      }
      case "turn.interrupted":
        this.newline();
        this.write(style.yellow(`  ${name}'s turn was interrupted${e.reason ? `: ${String(e.reason)}` : ""}\n`));
        this.finish(env.runId, false);
        break;
    }
  }

  private finish(runId: string, ok: boolean): void {
    this.active.delete(runId);
    this.knownRuns.add(runId);
    if (!ok) this.failed = true;
    // Group turns can fan out (hand-offs): wait until nothing of ours is running.
    setTimeout(() => {
      if (this.active.size) return;
      for (const w of this.waiters.splice(0)) w.resolve(!this.failed);
    }, 400);
  }

  private async approval(e: Record<string, unknown>): Promise<void> {
    const id = String(e.approvalId);
    const call = (e.toolCall ?? {}) as { title?: string; rawInput?: unknown };
    const options = (e.options ?? []) as ApprovalOption[];
    this.pendingApprovals.set(id, { title: call.title ?? "tool", options });
    const once = options.find((o) => o.kind === "allow_once");
    if (this.opts.approve && once) {
      await this.client.post(`/v1/approvals/${id}/decide`, { optionId: once.optionId, note: "orrery CLI --approve" });
      if (!this.opts.json) this.write(style.dim(`  ✓ approved: ${call.title ?? "tool"}\n`));
      return;
    }
    if (this.opts.json) return;
    this.write(`${style.yellow("  ? approval needed")} ${style.bold(call.title ?? "tool")}\n`);
    const input = typeof call.rawInput === "object" && call.rawInput ? JSON.stringify(call.rawInput) : "";
    if (input && input !== "{}") this.write(style.dim(`    ${input.slice(0, 300)}\n`));
    if (!this.rl && !this.io.isTTY) {
      this.write(style.dim(`    decide with: orrery approve ${id}   (or rerun with --approve)\n`));
      return;
    }
    options.forEach((o, i) => this.write(`    ${i + 1}) ${o.name}${style.dim(` [${o.kind}]`)}\n`));
    const rl = this.rl ?? createInterface({ input: this.io.stdin, output: this.io.stdout, terminal: this.io.isTTY });
    try {
      const answer = (await rl.question("    choose: ")).trim();
      const pick = options[Number(answer) - 1] ?? options.find((o) => o.optionId === answer || o.kind.startsWith(answer));
      if (!pick) {
        this.write(style.dim(`    not decided; decide later with: orrery approve ${id}\n`));
        return;
      }
      await this.client.post(`/v1/approvals/${id}/decide`, { optionId: pick.optionId, note: "orrery CLI" });
    } finally {
      if (!this.rl) rl.close();
    }
  }
}
