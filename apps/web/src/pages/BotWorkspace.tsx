import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { Bot, Message, Thread } from "../api";
import { Markdown } from "../components/Markdown";
import { RunBlock } from "../components/Run";
import { Avatar, Empty, ErrorBox, Meter, Seg, StatusDot, Tabs } from "../components/ui";
import { activityOf } from "../lib/fleet";
import { clock, duration, engineLabel, num, pct, relTime } from "../lib/format";
import { useApi, useCan, useLoad, useThread } from "../lib/hooks";
import { credits, isActive, type RunView } from "../lib/runs";

export function BotWorkspace() {
  const { botId = "", threadId } = useParams();
  const nav = useNavigate();
  const { api, pulse, toast } = useApi();
  const canWrite = useCan("member");
  const [showInspector, setShowInspector] = useState(() => typeof window === "undefined" || window.innerWidth > 1180);
  const [showThreads, setShowThreads] = useState(false);
  const [filter, setFilter] = useState("");

  const botQ = useLoad(async (a) => {
    const [b, approvals, active] = await Promise.all([a.getBot(botId), a.listApprovals(botId), a.activeRuns()]);
    return { ...b, approvals, active };
  }, [pulse], botId);
  const threadsQ = useLoad((a) => a.listThreads(botId), [pulse], botId);
  const bot = botQ.data?.bot;
  const threads = (threadsQ.data ?? []).filter((t) => t.botId === botId);

  useEffect(() => {
    if (!threadId && threads.length) nav(`/bots/${botId}/t/${threads[0]!.id}`, { replace: true });
  }, [threadId, threads, botId, nav]);

  const newThread = async () => {
    try {
      const t = await api.createThread(botId);
      threadsQ.reload();
      nav(`/bots/${botId}/t/${t.id}`);
      setShowThreads(false);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  if (botQ.error) return <div className="page"><ErrorBox error={botQ.error} /></div>;
  if (!bot) return <div className="page muted">Loading…</div>;
  const activity = activityOf(bot, botQ.data?.active ?? [], botQ.data?.approvals ?? []);
  const shown = threads.filter((t) => !filter || t.title.toLowerCase().includes(filter.toLowerCase()));
  const runningThreads = new Set((botQ.data?.active ?? []).map((r) => r.threadId));
  const waitingThreads = new Set((botQ.data?.approvals ?? []).map((a) => a.threadId));

  return (
    <div className={`workspace ${showInspector ? "show-inspector" : "no-inspector"} ${showThreads ? "show-threads" : ""}`}>
      <aside className="threads" aria-label="Conversations">
        <div className="threads-head">
          <div className="row">
            <Avatar bot={bot} activity={activity} size="sm" />
            <strong className="grow">{bot.name}</strong>
            <Link className="btn ghost sm" to={`/bots/${bot.id}/settings`}>
              Settings
            </Link>
          </div>
          {canWrite && (
            <button className="btn primary" onClick={() => void newThread()} disabled={bot.status !== "active"}>
              New conversation
            </button>
          )}
          <input className="input" placeholder="Filter conversations" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter conversations" />
        </div>
        <nav className="thread-list">
          {shown.map((t) => (
            <Link key={t.id} to={`/bots/${botId}/t/${t.id}`} className={t.id === threadId ? "active" : ""} onClick={() => setShowThreads(false)}>
              <div className="t-title">
                {waitingThreads.has(t.id) ? <StatusDot activity="waiting" /> : runningThreads.has(t.id) ? <StatusDot activity="working" /> : null}
                <span>{t.title}</span>
              </div>
              <div className="t-meta">
                {channelLabel(t.channel)}, {relTime(t.lastActivityAt)}
              </div>
            </Link>
          ))}
          {!shown.length && <p className="small muted" style={{ padding: 10 }}>{filter ? "No conversations match." : "No conversations yet."}</p>}
        </nav>
      </aside>
      {threadId && (threads.some((t) => t.id === threadId) || threadsQ.loading) ? (
        <Conversation key={threadId} bot={bot} thread={threads.find((t) => t.id === threadId)} threadId={threadId} showInspector={showInspector} toggleInspector={() => setShowInspector((v) => !v)} openThreads={() => setShowThreads(true)} onChanged={() => (threadsQ.reload(), botQ.reload())} />
      ) : (
        <section className="convo" style={{ display: "grid", placeItems: "center", padding: 24 }}>
          <Empty title={`Start a conversation with ${bot.name}`} action={canWrite ? <button className="btn primary" onClick={() => void newThread()}>New conversation</button> : undefined}>
            {bot.description}
          </Empty>
        </section>
      )}
    </div>
  );
}

function channelLabel(c: Thread["channel"]): string {
  return { web: "Chat", api: "API", slack: "Slack", routine: "Routine", peer: "From a teammate", webhook: "Webhook", group: "Group" }[c] ?? c;
}

type Item = { kind: "msg"; at: string; m: Message } | { kind: "run"; at: string; r: RunView };

function Conversation({ bot, thread, threadId, showInspector, toggleInspector, openThreads, onChanged }: { bot: Bot; thread: Thread | undefined; threadId: string; showInspector: boolean; toggleInspector: () => void; openThreads: () => void; onChanged: () => void }) {
  const { api, toast } = useApi();
  const canWrite = useCan("member");
  const { messages, runs, active, stream } = useThread(threadId);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const items = useMemo<Item[]>(() => {
    const withRun = new Set(runs.filter((r) => r.segments.length).map((r) => r.runId));
    const out: Item[] = [];
    for (const m of messages) {
      if (m.role === "assistant" && m.runId && withRun.has(m.runId)) continue;
      if (m.meta?.steered && m.runId && runs.some((r) => r.runId === m.runId)) continue;
      out.push({ kind: "msg", at: m.createdAt, m });
    }
    for (const r of runs) out.push({ kind: "run", at: r.startedAt, r });
    return out.sort((a, b) => a.at.localeCompare(b.at) || (a.kind === "msg" ? -1 : 1));
  }, [messages, runs]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  const inspected = runs.find((r) => r.runId === selectedRun) ?? runs[runs.length - 1] ?? null;
  const lastWithSession = [...runs].reverse().find((r) => r.mcp.length || r.config.length || r.commands.length) ?? null;

  return (
    <>
      <section className="convo" aria-label="Conversation">
        <header className="convo-head">
          <button className="btn ghost sm mobile-only" onClick={openThreads} aria-label="Show conversations">
            Conversations
          </button>
          <div className="grow">
            <h1>{thread?.title ?? "Conversation"}</h1>
            <div className="row wrap small muted" style={{ marginTop: 4 }}>
              <span className="chip">{engineLabel(bot.primary)}</span>
              {inspected?.model && <span className="chip">{inspected.model}</span>}
              {inspected?.mode && <span className="chip">Mode: {inspected.mode}</span>}
              {stream !== "open" && <span className="chip amber">{stream === "retrying" ? "Reconnecting" : "Connecting"}</span>}
            </div>
          </div>
          {inspected?.usage.contextPercent !== undefined && (
            <div style={{ width: 140 }} className="small muted ctx" title="How full the agent's context window is">
              Context {Math.round(inspected.usage.contextPercent)}%
              <Meter value={inspected.usage.contextPercent} label="Context window used" />
            </div>
          )}
          <button className="btn sm" onClick={toggleInspector} aria-pressed={showInspector}>
            Details
          </button>
        </header>
        <div
          className="convo-scroll"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          <div className="convo-inner">
            {!items.length && <Empty title="Nothing here yet">Send a message to get {bot.name} started.</Empty>}
            {items.map((it) =>
              it.kind === "msg" ? (
                <MessageView key={it.m.id} m={it.m} bot={bot} />
              ) : (
                <div className="msg" key={it.r.runId} onClick={() => setSelectedRun(it.r.runId)}>
                  <Avatar bot={bot} activity={isActive(it.r) ? (it.r.status === "waiting" ? "waiting" : "working") : undefined} size="sm" />
                  <div style={{ minWidth: 0 }}>
                    <div className="msg-author">
                      <b>{bot.name}</b>
                      <span>{clock(it.r.startedAt)}</span>
                      {it.r.status === "waiting" && <span className="chip amber">Waiting on you</span>}
                      {it.r.status === "running" && <span className="chip blue">Working</span>}
                    </div>
                    <RunBlock run={it.r} live={isActive(it.r)} onFeedback={(v) => void api.feedback(it.r.runId, v).then(() => toast("Thanks — feedback sent to the trace."))} />
                  </div>
                </div>
              ),
            )}
          </div>
        </div>
        {canWrite ? <Composer bot={bot} threadId={threadId} active={active} commands={lastWithSession?.commands ?? []} onSent={onChanged} /> : <div className="composer small muted">You have read-only access.</div>}
      </section>
      {showInspector && <Inspector run={inspected} session={lastWithSession} bot={bot} onClose={toggleInspector} />}
    </>
  );
}

function MessageView({ m, bot }: { m: Message; bot: Bot }) {
  const text = m.parts.map((p) => (p.type === "text" ? p.text : p.type === "resource_link" ? `[${p.name}](${p.uri})` : `[${p.type}]`)).join("\n");
  const isBot = m.role === "assistant";
  return (
    <div className={`msg ${isBot ? "assistant" : "user"}`}>
      {isBot ? <Avatar bot={bot} size="sm" /> : <span className="avatar sm" aria-hidden>{(m.author.name ?? "?")[0]}</span>}
      <div style={{ minWidth: 0 }}>
        <div className="msg-author">
          <b>{isBot ? bot.name : (m.author.name ?? m.author.id)}</b>
          <span>{clock(m.createdAt)}</span>
          {m.author.type === "system" && <span className="chip">{m.author.id.startsWith("routine:") ? "Routine" : m.author.id.startsWith("webhook:") ? "Webhook" : "System"}</span>}
        </div>
        <div className="msg-body">
          <Markdown text={text} />
        </div>
      </div>
    </div>
  );
}

function Composer({ bot, threadId, active, commands, onSent }: { bot: Bot; threadId: string; active: RunView | null; commands: Array<{ name: string; description: string; inputHint?: string }>; onSent: () => void }) {
  const { api, toast } = useApi();
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"steer" | "queue">("steer");
  // OpenCode and Orrery's own tool loop take no guidance mid-turn: messages run as the next turn.
  const steerable = (bot.primary.kind === "kiro-acp" || bot.primary.kind === "acp") && active?.provider !== "openai";
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const slash = text.startsWith("/") && !text.includes(" ") ? commands.filter((c) => c.name.startsWith(text.slice(1))) : [];

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(240, el.scrollHeight)}px`;
  }, [text]);

  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      const r = await api.sendMessage(threadId, { text: body, mode: active && steerable ? mode : "queue" });
      setText("");
      if (r.mode === "steer") toast(`Steering sent to ${bot.name}'s current turn.`);
      onSent();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slash.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setSel((s) => (s + (e.key === "ArrowDown" ? 1 : slash.length - 1)) % slash.length);
      return;
    }
    if (slash.length && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))) {
      e.preventDefault();
      setText(`/${slash[sel % slash.length]!.name} `);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="composer">
      {slash.length > 0 && (
        <div className="commands" role="listbox" aria-label="Agent commands">
          {slash.map((c, i) => (
            <button key={c.name} role="option" aria-selected={i === sel % slash.length} onMouseDown={(e) => (e.preventDefault(), setText(`/${c.name} `))}>
              <code>/{c.name}</code>
              <span className="muted">{c.description}</span>
            </button>
          ))}
        </div>
      )}
      <div className="composer-inner">
        <label className="sr-only" htmlFor="composer">
          Message {bot.name}
        </label>
        <textarea
          id="composer"
          ref={ref}
          rows={2}
          value={text}
          placeholder={bot.status === "paused" ? `${bot.name} is paused` : active ? (steerable && mode === "steer" ? `Steer ${bot.name}'s current turn` : `Queue a message for when ${bot.name} is done`) : `Message ${bot.name}`}
          onChange={(e) => {
            setText(e.target.value);
            setSel(0);
          }}
          onKeyDown={onKey}
          disabled={bot.status === "paused"}
        />
        <div className="composer-bar">
          {active ? (
            <>
              {steerable ? (
                <>
                  <Seg label="When to deliver" value={mode} onChange={setMode} options={[{ value: "steer", label: "Steer now" }, { value: "queue", label: "Queue next" }]} />
                  <span className="xs faint grow">{mode === "steer" ? "Injected into the running turn without restarting it." : "Runs as the next turn."}</span>
                </>
              ) : (
                <span className="xs faint grow">This agent can't take guidance mid-turn; your message runs as the next turn.</span>
              )}
              <button className="btn sm danger" onClick={() => void api.cancelRun(active.runId).catch((e: Error) => toast(e.message, "error"))}>
                Stop
              </button>
            </>
          ) : (
            <span className="xs faint grow">Enter to send, Shift+Enter for a new line{commands.length ? ", / for agent commands" : ""}</span>
          )}
          <button className="btn primary sm" onClick={() => void send()} disabled={!text.trim() || busy || bot.status === "paused"}>
            {active && steerable && mode === "steer" ? "Steer" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Inspector({ run, session, bot, onClose }: { run: RunView | null; session: RunView | null; bot: Bot; onClose: () => void }) {
  const [tab, setTab] = useState<"run" | "session" | "memory">("run");
  const runQ = useLoad(async (a) => (run ? a.getRun(run.runId) : null), [run?.runId, run?.status]);
  return (
    <aside className="inspector" aria-label="Details">
      <div style={{ padding: "8px 8px 0" }} className="row">
        <div className="grow">
          <Tabs value={tab} onChange={setTab} tabs={[{ value: "run", label: "Turn" }, { value: "session", label: "Session" }, { value: "memory", label: "Context" }]} />
        </div>
        <button className="btn ghost sm inspector-close" onClick={onClose} aria-label="Close details">
          Close
        </button>
      </div>
      {tab === "run" &&
        (run ? (
          <>
            <section>
              <h3>Turn</h3>
              <dl className="kv">
                <dt>Status</dt>
                <dd>{{ running: "Working", waiting: "Waiting on you", completed: "Completed", failed: "Failed", cancelled: "Stopped", interrupted: "Interrupted" }[run.status]}</dd>
                <dt>Provider</dt>
                <dd>{run.provider === "kiro-acp" ? `Kiro over ACP (${run.engine === "v2" ? "CLI v2" : "CLI V3"})` : run.provider === "opencode-acp" ? "OpenCode over ACP" : run.provider === "openai" ? "OpenAI-compatible" : run.provider}</dd>
                {run.model && (
                  <>
                    <dt>Model</dt>
                    <dd>{run.model}</dd>
                  </>
                )}
                {run.route && (
                  <>
                    <dt>Routing</dt>
                    <dd>
                      {run.route.reason}
                      {run.route.scores?.needsAgent !== undefined && <span className="faint"> (agent needed: {pct(run.route.scores.needsAgent)})</span>}
                    </dd>
                  </>
                )}
                <dt>Started</dt>
                <dd>{relTime(run.startedAt)}</dd>
                <dt>Events</dt>
                <dd>
                  {run.eventCount}
                  {run.unknown ? <span className="faint">, {run.unknown} passed through unrecognized</span> : null}
                </dd>
              </dl>
              {runQ.data?.traceUrl && (
                <p style={{ marginTop: 10 }}>
                  <a href={runQ.data.traceUrl} target="_blank" rel="noreferrer noopener" className="small">
                    Open trace in Langfuse
                  </a>
                </p>
              )}
            </section>
            <section>
              <h3>Usage</h3>
              <dl className="kv">
                <dt>Input</dt>
                <dd>{num(run.usage.inputTokens)} tokens</dd>
                <dt>Output</dt>
                <dd>{num(run.usage.outputTokens)} tokens</dd>
                {credits(run.usage) > 0 && (
                  <>
                    <dt>Kiro credits</dt>
                    <dd>{credits(run.usage).toFixed(2)}</dd>
                  </>
                )}
                {run.usage.costUsd !== undefined && (
                  <>
                    <dt>Cost</dt>
                    <dd>${run.usage.costUsd.toFixed(4)}</dd>
                  </>
                )}
                <dt>Duration</dt>
                <dd>{duration(run.usage.turnDurationMs)}</dd>
              </dl>
              {run.usage.contextPercent !== undefined && (
                <div style={{ marginTop: 10 }} className="small">
                  Context window {Math.round(run.usage.contextPercent)}% full
                  <Meter value={run.usage.contextPercent} label="Context window" />
                </div>
              )}
            </section>
            {Object.keys(run.tools).length > 0 && (
              <section>
                <h3>Tool calls</h3>
                <div className="list">
                  {Object.values(run.tools).map((t) => (
                    <div key={t.toolCallId} className="spread">
                      <span className="mono xs" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {t.title}
                      </span>
                      <span className={`chip ${t.status === "failed" ? "red" : t.status === "completed" ? "" : "blue"}`}>{t.status === "failed" ? (t.failureReason ?? "failed") : t.status.replace("_", " ")}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        ) : (
          <section className="small muted">No turns yet.</section>
        ))}
      {tab === "session" && (
        <>
          <section>
            <h3>Agent</h3>
            <dl className="kv">
              <dt>Engine</dt>
              <dd>{engineLabel(bot.primary)}</dd>
              <dt>Session</dt>
              <dd className="mono xs">{session?.sessionId ?? "Created on first turn"}</dd>
              {session?.mode && (
                <>
                  <dt>Mode</dt>
                  <dd>{session.mode}</dd>
                </>
              )}
              {session?.config.map((c) => (
                <div key={c.id} style={{ display: "contents" }}>
                  <dt>{c.name}</dt>
                  <dd>{String(c.currentValue ?? "–")}</dd>
                </div>
              ))}
              <dt>Computer</dt>
              <dd>{bot.computer.enabled ? `${bot.computer.size}, network ${bot.computer.network.mode}` : "None (model only)"}</dd>
            </dl>
          </section>
          <section>
            <h3>MCP servers</h3>
            {session?.mcp.length ? (
              <div className="list">
                {session.mcp.map((s) => (
                  <div key={s.name} className="spread">
                    <span>{s.name}</span>
                    <span className={`chip ${s.state === "connected" ? "green" : s.state === "failed" ? "red" : "dashed"}`}>
                      {s.state}
                      {s.toolCount !== undefined ? `, ${s.toolCount} tools` : ""}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="small muted">Reported by the agent once a session starts.</p>
            )}
          </section>
          {session?.commands.length ? (
            <section>
              <h3>Commands</h3>
              <div className="list">
                {session.commands.map((c) => (
                  <div key={c.name}>
                    <code>/{c.name}</code> <span className="muted">{c.description}</span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}
      {tab === "memory" &&
        (run ? (
          <>
            <section>
              <h3>Recalled memories</h3>
              {run.recalled.length ? (
                <div className="list">
                  {run.recalled.map((m) => (
                    <div key={m.id}>
                      <span className="chip">{m.kind.replace("_", " ")}</span> {m.content} <span className="faint xs">{m.score.toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="small muted">None used for this turn.</p>
              )}
            </section>
            <section>
              <h3>Knowledge</h3>
              {run.knowledge.length ? (
                <div className="list">
                  {run.knowledge.map((k) => (
                    <div key={k.chunkId}>
                      <strong>{k.sourceTitle}</strong>
                      <div className="muted xs">{k.excerpt}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="small muted">No knowledge passages used.</p>
              )}
            </section>
            <section>
              <h3>Learned this turn</h3>
              {run.written.length ? (
                <div className="list">
                  {run.written.map((w) => (
                    <div key={w.id}>
                      <span className="chip green">{w.action}</span> {w.content}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="small muted">Nothing new.</p>
              )}
              <p style={{ marginTop: 10 }}>
                <Link className="small" to={`/memory?bot=${bot.id}`}>
                  Open {bot.name}'s memory
                </Link>
              </p>
            </section>
          </>
        ) : (
          <section className="small muted">No turns yet.</section>
        ))}
    </aside>
  );
}
