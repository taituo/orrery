import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { Bot, Group, Message, Thread } from "../api";
import { Inspector } from "../components/Inspector";
import { Markdown } from "../components/Markdown";
import { Orb, OrbStack, Wave } from "../components/Orb";
import { RunBlock } from "../components/Run";
import { ErrorBox, Seg } from "../components/ui";
import { activityOf, useFleet } from "../lib/fleet";
import { clock, relTime } from "../lib/format";
import { useApi, useCan, useLoad, useThread } from "../lib/hooks";
import { isActive, type RunView } from "../lib/runs";

/* ------------------------------------------------------------------ bot conversations */

export function BotChat() {
  const { botId = "", threadId } = useParams();
  const nav = useNavigate();
  const { api, pulse, toast } = useApi();
  const fleet = useFleet();
  const botQ = useLoad((a) => a.getBot(botId), [pulse], botId);
  const threadsQ = useLoad((a) => a.listThreads(botId), [pulse], botId);
  const bot = botQ.data?.bot;
  const threads = (threadsQ.data ?? []).filter((t) => t.botId === botId);
  const current = threadId ?? threads[0]?.id;
  const [showHistory, setShowHistory] = useState(false);

  if (botQ.error) return <div className="page glass"><ErrorBox error={botQ.error} /></div>;
  if (!bot) return <div className="convo glass" aria-busy />;
  const activity = activityOf(bot, fleet.active, fleet.approvals);
  const thread = threads.find((t) => t.id === current);

  const newConversation = async () => {
    try {
      const t = await api.createThread(bot.id);
      threadsQ.reload();
      setShowHistory(false);
      nav(`/bots/${bot.id}/t/${t.id}`);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  return (
    <Conversation
      key={current ?? "new"}
      threadId={current ?? null}
      bots={new Map([[bot.id, bot]])}
      steerable={(bot.primary.kind === "kiro-acp" || bot.primary.kind === "acp") && bot.status === "active"}
      disabled={bot.status !== "active" ? `${bot.name} is ${bot.status}.` : null}
      placeholder={`Message ${bot.name}`}
      emptyTitle={`Say hello to ${bot.name}`}
      emptyText={bot.description || "Ask for something to be done; tool calls that need you show up here."}
      ensureThread={async (text) => {
        const t = await api.createThread(bot.id, text.slice(0, 60));
        threadsQ.reload();
        nav(`/bots/${bot.id}/t/${t.id}`, { replace: true });
        return t.id;
      }}
      head={
        <>
          <Orb id={bot.id} name={bot.name} avatar={bot.avatar ?? null} activity={activity} size="lg" />
          <div className="grow">
            <h1>{bot.name}</h1>
            <Presence activity={activity} idle={thread?.title ?? bot.description} />
          </div>
          <div style={{ position: "relative" }}>
            <button className="btn ghost sm" onClick={() => setShowHistory((v) => !v)} aria-expanded={showHistory}>
              Conversations
            </button>
          </div>
          <Link className="btn ghost sm" to={`/bots/${bot.id}/settings`}>
            Settings
          </Link>
        </>
      }
      overlay={
        showHistory && (
          <nav className="history" aria-label={`Conversations with ${bot.name}`}>
            <button className="btn primary sm" style={{ width: "100%", marginBottom: 6 }} onClick={() => void newConversation()} disabled={bot.status !== "active"}>
              New conversation
            </button>
            {threads.map((t) => (
              <Link key={t.id} to={`/bots/${bot.id}/t/${t.id}`} className={t.id === current ? "active" : ""} onClick={() => setShowHistory(false)}>
                <div>{t.title}</div>
                <div className="t-meta">{relTime(t.lastActivityAt)}</div>
              </Link>
            ))}
            {!threads.length && <p className="small muted" style={{ padding: 10 }}>No conversations yet.</p>}
          </nav>
        )
      }
    />
  );
}

function Presence({ activity, idle }: { activity: ReturnType<typeof activityOf>; idle?: string | null }) {
  if (activity === "working")
    return (
      <div className="presence working">
        <Wave /> working
      </div>
    );
  if (activity === "waiting") return <div className="presence waiting">waiting for you</div>;
  if (activity === "paused") return <div className="presence">paused</div>;
  return <div className="presence">{idle ?? ""}</div>;
}

/* ------------------------------------------------------------------ group conversations */

export function GroupChat() {
  const { groupId = "" } = useParams();
  const { pulse } = useApi();
  const fleet = useFleet();
  const groupsQ = useLoad((a) => a.listGroups(), [pulse]);
  const [showMembers, setShowMembers] = useState(false);
  const group = groupsQ.data?.find((g) => g.id === groupId);
  if (groupsQ.error) return <div className="page glass"><ErrorBox error={groupsQ.error} /></div>;
  if (!groupsQ.data || !fleet.data) return <div className="convo glass" aria-busy />;
  if (!group) return <div className="page glass"><h1>Group not found</h1><p className="muted">It may have been archived. <Link to="/">Back home</Link></p></div>;
  const bots = new Map(fleet.bots.filter((b) => group.members.some((m) => m.botId === b.id)).map((b) => [b.id, b]));
  const lead = group.members.find((m) => m.lead) ?? group.members[0];
  const others = group.members.filter((m) => m !== lead).map((m) => m.name);
  const working = group.members.filter((m) => fleet.activity[m.botId] === "working").map((m) => m.name);
  const waiting = group.members.filter((m) => fleet.activity[m.botId] === "waiting").map((m) => m.name);

  return (
    <Conversation
      key={group.threadId}
      threadId={group.threadId}
      bots={bots}
      group={group}
      steerable={false}
      disabled={null}
      placeholder={`Message ${group.name}. Mention @${others[0] ?? lead?.name ?? "a bot"} to ask someone specific`}
      emptyTitle={group.name}
      emptyText={`${lead?.name ?? "The lead"} answers messages that mention no one. Mention a bot with @ to ask it directly; bots hand work to each other the same way.`}
      head={
        <>
          <OrbStack members={group.members} size="lg" />
          <div className="grow">
            <h1>{group.name}</h1>
            <div className={`presence ${waiting.length ? "waiting" : working.length ? "working" : ""}`}>
              {waiting.length ? (
                <>{list(waiting)} waiting for you</>
              ) : working.length ? (
                <>
                  <Wave /> {list(working)} working
                </>
              ) : (
                <>
                  {lead?.name} leads{others.length ? `, with ${list(others)}` : ""}
                </>
              )}
            </div>
          </div>
          <button className="btn ghost sm" onClick={() => setShowMembers((v) => !v)} aria-expanded={showMembers}>
            Members
          </button>
        </>
      }
      overlay={showMembers && <GroupMembers group={group} onClose={() => setShowMembers(false)} onChanged={groupsQ.reload} />}
    />
  );
}

const list = (names: string[]) => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

function GroupMembers({ group, onClose, onChanged }: { group: Group; onClose: () => void; onChanged: () => void }) {
  const { api, toast } = useApi();
  const fleet = useFleet();
  const canEdit = useCan("member");
  const [ids, setIds] = useState(group.members.map((m) => m.botId));
  const save = async () => {
    try {
      await api.updateGroup(group.id, { botIds: ids });
      toast("Group updated.");
      onChanged();
      onClose();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  return (
    <div className="history" role="dialog" aria-label="Group members">
      <p className="small muted" style={{ padding: "6px 10px" }}>
        The first bot leads: it answers messages that mention no one.
      </p>
      {fleet.bots
        .filter((b) => b.status !== "archived")
        .map((b) => {
          const on = ids.includes(b.id);
          return (
            <label key={b.id} className="check" style={{ padding: "6px 10px", width: "100%" }}>
              <input type="checkbox" checked={on} disabled={!canEdit || (!on && ids.length >= 6)} onChange={(e) => setIds((x) => (e.target.checked ? [...x, b.id] : x.filter((y) => y !== b.id)))} />
              <Orb id={b.id} name={b.name} avatar={b.avatar ?? null} size="sm" />
              <span className="grow">{b.name}</span>
              {ids[0] === b.id ? <span className="chip">lead</span> : on && canEdit ? <button type="button" className="btn ghost sm" onClick={(e) => (e.preventDefault(), setIds((x) => [b.id, ...x.filter((y) => y !== b.id)]))}>Make lead</button> : null}
            </label>
          );
        })}
      {canEdit && (
        <div className="row" style={{ padding: 8, justifyContent: "flex-end" }}>
          <button className="btn ghost sm" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary sm" disabled={!ids.length} onClick={() => void save()}>
            Save
          </button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ the conversation itself */

type Item = { kind: "msg"; at: string; m: Message } | { kind: "run"; at: string; r: RunView };

function Conversation(props: {
  threadId: string | null;
  bots: Map<string, Bot>;
  group?: Group;
  steerable: boolean;
  disabled: string | null;
  placeholder: string;
  emptyTitle: string;
  emptyText: string;
  head: ReactNode;
  overlay?: ReactNode;
  ensureThread?: (firstText: string) => Promise<string>;
}) {
  const { api, me, toast } = useApi();
  const canWrite = useCan("member");
  const { messages, runs, runMeta, active, reloadMessages } = useThread(props.threadId ?? undefined);
  const [showDetails, setShowDetails] = useState(false);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);

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

  const firstBot = [...props.bots.values()][0];
  const inspected = runs.find((r) => r.runId === selectedRun) ?? runs[runs.length - 1] ?? null;
  const inspectedBot = (inspected && props.bots.get(inspected.botId)) ?? firstBot;
  const lastWithSession = [...runs].reverse().find((r) => (!inspected || r.botId === inspected.botId) && (r.mcp.length || r.config.length || r.commands.length)) ?? null;
  const memberNames = props.group?.members.map((m) => m.name) ?? [];

  return (
    <div className={`chat ${showDetails && inspectedBot ? "with-drawer" : ""}`}>
      <section className="convo glass" aria-label="Conversation">
        <header className="convo-head">
          {props.head}
          <button className="btn ghost sm" onClick={() => setShowDetails((v) => !v)} aria-pressed={showDetails} disabled={!runs.length}>
            Details
          </button>
        </header>
        {props.overlay}
        <div
          className="convo-scroll"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
          }}
        >
          <div className="convo-inner">
            {!items.length && (
              <div className="empty" style={{ marginTop: "8vh" }}>
                <h3>{props.emptyTitle}</h3>
                <p className="small" style={{ maxWidth: "46ch", margin: "0 auto" }}>
                  {props.emptyText}
                </p>
              </div>
            )}
            {items.map((it) => {
              if (it.kind === "msg") return <MessageView key={it.m.id} m={it.m} bots={props.bots} mine={it.m.author.id === me.userId} names={memberNames} />;
              const bot = props.bots.get(it.r.botId) ?? firstBot;
              const trigger = byId.get(runMeta[it.r.runId]?.triggerMessageId ?? "");
              const from = trigger?.author.type === "bot" ? props.bots.get(trigger.author.id)?.name ?? trigger.author.name : null;
              const live = isActive(it.r);
              return (
                <div className="msg" key={it.r.runId} onClick={() => setSelectedRun(it.r.runId)}>
                  {bot ? <Orb id={bot.id} name={bot.name} avatar={bot.avatar ?? null} activity={live ? (it.r.status === "waiting" ? "waiting" : "working") : undefined} size="sm" /> : <span />}
                  <div style={{ minWidth: 0 }}>
                    <div className="msg-author">
                      <b>{bot?.name ?? "Bot"}</b>
                      {from && <span>asked by {from}</span>}
                      <span>{clock(it.r.startedAt)}</span>
                      {it.r.status === "running" && <Wave label="working" />}
                    </div>
                    <RunBlock run={it.r} live={live} onFeedback={(v) => void api.feedback(it.r.runId, v).then(() => toast("Thanks. The rating is on the trace."))} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div className="composer-wrap">
          {canWrite ? (
            props.disabled ? (
              <div className="composer composer-hint" style={{ padding: "16px 20px" }}>
                {props.disabled}
              </div>
            ) : (
              <Composer
                threadId={props.threadId}
                ensureThread={props.ensureThread}
                active={active}
                steerable={props.steerable}
                placeholder={props.placeholder}
                commands={lastWithSession?.commands ?? []}
                members={props.group?.members ?? []}
                leadName={props.group?.members.find((m) => m.lead)?.name ?? null}
                botName={firstBot?.name ?? "the bot"}
                onSent={() => void reloadMessages()}
              />
            )
          ) : (
            <div className="composer composer-hint" style={{ padding: "16px 20px" }}>
              You can read this conversation; members can write.
            </div>
          )}
        </div>
      </section>
      {showDetails && inspectedBot && <Inspector run={inspected} session={lastWithSession} bot={inspectedBot} onClose={() => setShowDetails(false)} />}
    </div>
  );
}

function MessageView({ m, bots, mine, names }: { m: Message; bots: Map<string, Bot>; mine: boolean; names: string[] }) {
  const text = m.parts.map((p) => (p.type === "text" ? p.text : p.type === "resource_link" ? `[${p.name}](${p.uri})` : `[${p.type}]`)).join("\n");
  if (m.role === "assistant" || m.author.type === "bot") {
    const bot = bots.get(m.author.id);
    return (
      <div className="msg">
        {bot ? <Orb id={bot.id} name={bot.name} avatar={bot.avatar ?? null} size="sm" /> : <span />}
        <div style={{ minWidth: 0 }}>
          <div className="msg-author">
            <b>{bot?.name ?? m.author.name ?? "Bot"}</b>
            <span>{clock(m.createdAt)}</span>
          </div>
          <div className="msg-body">
            <Markdown text={text} />
          </div>
        </div>
      </div>
    );
  }
  if (m.role === "system" || m.author.type === "system") {
    const source = m.author.id.startsWith("routine:") ? `Routine: ${m.author.name ?? ""}` : m.author.id.startsWith("webhook:") ? `From ${m.author.name ?? "a webhook"}` : "Orrery";
    return (
      <div className="msg user">
        <div className="bubble">
          <div className="who">
            {source}, {clock(m.createdAt)}
          </div>
          <div className="msg-body">
            <Markdown text={text} />
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="msg user">
      <div className="bubble">
        {!mine && (
          <div className="who">
            {m.author.name ?? m.author.id}, {clock(m.createdAt)}
          </div>
        )}
        <div className="msg-body" style={{ whiteSpace: "pre-wrap" }}>
          {withMentions(text, names)}
        </div>
      </div>
    </div>
  );
}

function withMentions(text: string, names: string[]): ReactNode {
  if (!names.length) return text;
  const alts = [...names, "all", "everyone"].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(@(?:${alts.join("|")}))(?![\\w-])`, "gi");
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(re)) {
    out.push(text.slice(last, match.index));
    out.push(
      <span className="mention" key={match.index}>
        {match[0]}
      </span>,
    );
    last = match.index! + match[0].length;
  }
  out.push(text.slice(last));
  return out;
}

/* ------------------------------------------------------------------ composer */

function Composer(props: {
  threadId: string | null;
  ensureThread: ((text: string) => Promise<string>) | undefined;
  active: RunView | null;
  steerable: boolean;
  placeholder: string;
  commands: Array<{ name: string; description: string; inputHint?: string }>;
  members: Group["members"];
  leadName: string | null;
  botName: string;
  onSent: () => void;
}) {
  const { api, toast } = useApi();
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"steer" | "queue">("steer");
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const caret = ref.current?.selectionStart ?? text.length;
  const mentionQuery = props.members.length ? /(^|\s)@([\w-]*)$/.exec(text.slice(0, caret))?.[2] : undefined;
  const mentionHits = mentionQuery !== undefined ? props.members.filter((m) => m.name.toLowerCase().startsWith(mentionQuery.toLowerCase())) : [];
  const slash = !props.members.length && text.startsWith("/") && !text.includes(" ") ? props.commands.filter((c) => c.name.startsWith(text.slice(1))) : [];
  const steering = Boolean(props.active) && props.steerable;

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
      const threadId = props.threadId ?? (props.ensureThread ? await props.ensureThread(body) : null);
      if (!threadId) return;
      const r = await api.sendMessage(threadId, { text: body, mode: steering ? mode : "queue" });
      setText("");
      props.onSent();
      if (r.mode === "steer") toast(`Sent to ${props.botName}'s current turn.`);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const insertMention = (name: string) => {
    const before = text.slice(0, caret).replace(/@([\w-]*)$/, `@${name} `);
    setText(before + text.slice(caret));
    setSel(0);
    requestAnimationFrame(() => ref.current?.focus());
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const pop = mentionHits.length ? mentionHits.length : slash.length;
    if (pop && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setSel((s) => (s + (e.key === "ArrowDown" ? 1 : pop - 1)) % pop);
      return;
    }
    if (pop && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))) {
      e.preventDefault();
      if (mentionHits.length) insertMention(mentionHits[sel % mentionHits.length]!.name);
      else setText(`/${slash[sel % slash.length]!.name} `);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const hint = props.members.length
    ? `${props.leadName ?? "The lead"} answers unless you mention someone`
    : steering
      ? mode === "steer"
        ? `Guides ${props.botName}'s running turn`
        : "Runs as the next turn"
      : props.active && !props.steerable
        ? `${props.botName} can't take guidance mid-turn; this runs next`
        : "Enter to send, Shift+Enter for a new line";

  return (
    <>
      {(mentionHits.length > 0 || slash.length > 0) && (
        <div className="popover" role="listbox" aria-label={mentionHits.length ? "Mention a bot" : "Agent commands"}>
          {mentionHits.length
            ? mentionHits.map((m, i) => (
                <button key={m.botId} role="option" aria-selected={i === sel % mentionHits.length} onMouseDown={(e) => (e.preventDefault(), insertMention(m.name))}>
                  <Orb id={m.botId} name={m.name} avatar={m.avatar ?? null} size="sm" />
                  {m.name}
                  {m.lead && <span className="faint small">lead</span>}
                </button>
              ))
            : slash.map((c, i) => (
                <button key={c.name} role="option" aria-selected={i === sel % slash.length} onMouseDown={(e) => (e.preventDefault(), setText(`/${c.name} `))}>
                  <code>/{c.name}</code>
                  <span className="muted">{c.description}</span>
                </button>
              ))}
        </div>
      )}
      <div className="composer">
        <label className="sr-only" htmlFor="composer">
          {props.placeholder}
        </label>
        <textarea id="composer" ref={ref} rows={1} value={text} placeholder={props.placeholder} onChange={(e) => (setText(e.target.value), setSel(0))} onKeyDown={onKey} />
        <div className="composer-bar">
          {steering && <Seg label="When to deliver" value={mode} onChange={setMode} options={[{ value: "steer", label: "Now" }, { value: "queue", label: "Next" }]} />}
          <span className="composer-hint">{hint}</span>
          {props.active && (
            <button className="btn ghost sm" onClick={() => void api.cancelRun(props.active!.runId).catch((e: Error) => toast(e.message, "error"))}>
              Stop
            </button>
          )}
          <button className="send" onClick={() => void send()} disabled={!text.trim() || busy} aria-label="Send">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
              <path d="M9 14.5V3.5M4 8.5l5-5 5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>
    </>
  );
}

export type { Thread };
