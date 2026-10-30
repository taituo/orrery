import { Link } from "react-router";
import type { Bot } from "../api";
import { Meter, Tabs } from "./ui";
import { duration, engineLabel, num, pct, relTime } from "../lib/format";
import { useLoad } from "../lib/hooks";
import { credits, type RunView } from "../lib/runs";
import { useState, type ReactNode } from "react";

/** Details of a conversation: the selected turn, the agent session, and what it remembered. */
export function Inspector({ run, session, bot, onClose, extra }: { run: RunView | null; session: RunView | null; bot: Bot; onClose: () => void; extra?: ReactNode }) {
  const [tab, setTab] = useState<"run" | "session" | "memory">("run");
  const runQ = useLoad(async (a) => (run ? a.getRun(run.runId) : null), [run?.runId, run?.status]);
  return (
    <aside className="drawer glass" aria-label="Details">
      <div className="row">
        <div className="grow">
          <Tabs value={tab} onChange={setTab} tabs={[{ value: "run", label: "Turn" }, { value: "session", label: "Session" }, { value: "memory", label: "Context" }]} />
        </div>
        <button className="btn ghost sm" onClick={onClose} aria-label="Close details">
          Close
        </button>
      </div>
      {extra}
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
