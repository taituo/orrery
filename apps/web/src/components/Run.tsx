import { useState } from "react";
import type { PlanEntry, ToolCallState } from "@orrery/core/pure";
import { useApi, useCan } from "../lib/hooks";
import { duration, num, pct, relTime } from "../lib/format";
import { credits, type ApprovalView, type RunView } from "../lib/runs";
import { KindIcon } from "./ui";
import { Markdown } from "./Markdown";

const STATUS_LABEL: Record<string, string> = { pending: "Queued", in_progress: "Running", completed: "Done", failed: "Failed" };

export function ToolCard({ tool, defaultOpen }: { tool: ToolCallState; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const failure = tool.status === "failed" ? (tool.failureReason === "denied" ? "Denied" : tool.failureReason === "cancelled" ? "Cancelled" : "Failed") : null;
  const textOut = (tool.content ?? []).flatMap((c) => (c.type === "content" && c.content.type === "text" ? [c.content.text] : []));
  const diffs = (tool.content ?? []).filter((c): c is Extract<NonNullable<ToolCallState["content"]>[number], { type: "diff" }> => c.type === "diff");
  const isTerminal = tool.kind === "execute";
  const source = tool.identity?.source === "mcp" ? `MCP: ${tool.identity.server}` : tool.identity?.source === "platform" ? "Orrery" : null;
  return (
    <div className={`tool ${tool.status}`}>
      <button className="tool-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="tool-kind">
          <KindIcon kind={tool.kind} />
        </span>
        <span className="tool-title" title={tool.title}>
          {tool.title}
        </span>
        <span className="row">
          {source && <span className="chip">{source}</span>}
          {failure ? <span className="chip red">{failure}</span> : <span className={`chip ${tool.status === "completed" ? "" : tool.status === "in_progress" ? "blue" : "dashed"}`}>{STATUS_LABEL[tool.status]}</span>}
        </span>
      </button>
      {open && (
        <div className="tool-body">
          {tool.locations?.length ? (
            <div className="small muted">
              {tool.locations.map((l) => (
                <code key={`${l.path}:${l.line ?? ""}`}>{l.line ? `${l.path}:${l.line}` : l.path}</code>
              ))}
            </div>
          ) : null}
          {tool.rawInput !== undefined && !isTerminal && (
            <details>
              <summary className="small muted">Input</summary>
              <pre className="small">{JSON.stringify(tool.rawInput, null, 2)}</pre>
            </details>
          )}
          {diffs.map((d, i) => (
            <div className="diff mono" key={i}>
              <div className="diff-path">{d.path}</div>
              {d.oldText ? d.oldText.split("\n").map((l, j) => <div className="del" key={`d${j}`}>− {l}</div>) : null}
              {d.newText.split("\n").map((l, j) => (
                <div className="add" key={`a${j}`}>
                  + {l}
                </div>
              ))}
            </div>
          ))}
          {textOut.length > 0 && (isTerminal ? <pre className="terminal mono">{textOut.join("\n")}</pre> : <pre className="small">{textOut.join("\n")}</pre>)}
          {tool.annotations && (
            <p className="xs faint">
              Server hints (unverified): {Object.entries(tool.annotations).filter(([, v]) => v).map(([k]) => k.replace(/Hint$/, "")).join(", ") || "none"}
            </p>
          )}
          {!textOut.length && !diffs.length && tool.status !== "completed" && <p className="small faint">No output yet.</p>}
        </div>
      )}
    </div>
  );
}

export function Plan({ entries }: { entries: PlanEntry[] }) {
  if (!entries.length) return null;
  const done = entries.filter((e) => e.status === "completed").length;
  return (
    <div className="plan">
      <h4>
        Plan, {done} of {entries.length} done
      </h4>
      <ol>
        {entries.map((e, i) => (
          <li key={i} className={e.status}>
            <i className="box" aria-hidden />
            <span>
              {e.content}
              <span className="sr-only"> ({e.status.replace("_", " ")})</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function ApprovalCard({ a, compact }: { a: ApprovalView; compact?: boolean }) {
  const { api, toast } = useApi();
  const canDecide = useCan("member");
  const isAdmin = useCan("admin");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const cmd = typeof a.toolCall.rawInput === "object" && a.toolCall.rawInput && "command" in (a.toolCall.rawInput as Record<string, unknown>) ? String((a.toolCall.rawInput as Record<string, unknown>).command) : a.toolCall.rawInput !== undefined ? JSON.stringify(a.toolCall.rawInput, null, 2) : a.toolCall.title;

  if (a.resolved) {
    const allowed = a.resolved.optionKind?.startsWith("allow");
    return (
      <div className="approval resolved small">
        <span className={`chip ${allowed ? "green" : a.resolved.outcome === "selected" ? "red" : ""}`}>{a.resolved.outcome === "selected" ? (allowed ? (a.resolved.optionKind === "allow_always" ? "Always allowed" : "Allowed") : "Denied") : a.resolved.outcome === "expired" ? "Expired" : "Cancelled"}</span>{" "}
        <span className="muted">
          {a.toolCall.title}
          {a.resolved.actor ? ` by ${a.resolved.actor}` : a.resolved.decidedBy !== "user" ? ` by ${a.resolved.decidedBy}` : ""}
        </span>
      </div>
    );
  }

  const decide = async (optionId: string, kind: string) => {
    setBusy(optionId);
    try {
      await api.decideApproval(a.approvalId, {
        optionId,
        ...(kind === "allow_always" && a.consent?.resource ? { persist: { scope: "workspace", resource: a.consent.resource } } : {}),
        ...(note ? { note } : {}),
      });
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="approval" role="group" aria-label={`Approval needed: ${a.toolCall.title}`}>
      <div className="spread">
        <strong>Approval needed</strong>
        <span className="xs muted">expires {relTime(a.expiresAt)}</span>
      </div>
      <pre className="approval-cmd mono">{cmd}</pre>
      {!compact && (
        <div className="row wrap small muted">
          {a.policy.reason && <span>{a.policy.reason}.</span>}
          {a.consent?.workspaceRoot && (
            <span>
              Workspace <code>{a.consent.workspaceRoot}</code>
            </span>
          )}
        </div>
      )}
      {typeof a.policy.risk === "number" && (
        <div className="risk">
          <span>Risk</span>
          <div className={`meter ${a.policy.risk > 0.7 ? "bad" : a.policy.risk > 0.4 ? "warn" : ""}`}>
            <i style={{ width: `${a.policy.risk * 100}%` }} />
          </div>
          <span>{pct(a.policy.risk)}</span>
        </div>
      )}
      {canDecide ? (
        <>
          {!compact && <input className="input" placeholder="Note for the audit log (optional)" value={note} onChange={(e) => setNote(e.target.value)} />}
          <div className="row wrap">
            {/* Options are exactly what the agent offered — never synthesized. */}
            {a.options.map((o) => {
              const always = o.kind === "allow_always";
              const disabled = Boolean(busy) || (always && !isAdmin);
              return (
                <button
                  key={o.optionId}
                  className={`btn ${o.kind === "allow_once" ? "primary" : o.kind.startsWith("reject") ? "danger" : ""}`}
                  disabled={disabled}
                  title={always && !isAdmin ? "Only admins can grant standing permissions" : undefined}
                  onClick={() => void decide(o.optionId, o.kind)}
                >
                  {busy === o.optionId ? "Sending…" : o.name}
                </button>
              );
            })}
          </div>
        </>
      ) : (
        <p className="small muted">Waiting for a member to decide.</p>
      )}
    </div>
  );
}

export function RunBlock({ run, live, onFeedback }: { run: RunView; live: boolean; onFeedback?: (v: number) => void }) {
  const [rated, setRated] = useState<number | null>(null);
  const last = run.segments.length - 1;
  return (
    <div className="run">
      {(run.route || run.recalled.length > 0 || run.knowledge.length > 0) && (
        <div className="run-context">
          {run.route && (
            <span className="chip" title={run.route.reason}>
              {run.route.provider.startsWith("openai") ? `Answered by ${run.route.model ?? "fast model"}` : "Routed to agent"}
            </span>
          )}
          {run.recalled.length > 0 && <span className="chip" title={run.recalled.map((m) => m.content).join("\n")}>Recalled {run.recalled.length} memories</span>}
          {run.knowledge.length > 0 && <span className="chip" title={run.knowledge.map((k) => k.sourceTitle).join("\n")}>Used {run.knowledge.length} knowledge {run.knowledge.length === 1 ? "passage" : "passages"}</span>}
        </div>
      )}
      <Plan entries={run.plan} />
      {run.segments.map((s, i) => {
        switch (s.kind) {
          case "text":
            return <Markdown key={i} text={s.text} streaming={live && i === last} />;
          case "thought":
            return (
              <details key={i} className="thought" open={live && i === last}>
                <summary>Thinking</summary>
                {s.text}
              </details>
            );
          case "tool": {
            const t = run.tools[s.id];
            return t ? <ToolCard key={s.id} tool={t} defaultOpen={t.status === "failed" || (live && t.kind === "edit")} /> : null;
          }
          case "approval": {
            const a = run.approvals[s.id];
            return a ? <ApprovalCard key={s.id} a={a} /> : null;
          }
          case "steer":
            return (
              <div key={i} className={`steer ${s.status}`}>
                {s.status === "queued" ? "Steering queued: " : "Steered: "}
                {s.text}
              </div>
            );
          case "notice":
            return (
              <div key={i} className={`notice ${s.severity}`}>
                <strong>{s.title}</strong> {s.message}
              </div>
            );
          case "auth":
            return (
              <div key={i} className="notice">
                <strong>Sign-in required{s.server ? ` for ${s.server}` : ""}.</strong> {s.message}{" "}
                {s.url && /^https:/.test(s.url) && (
                  <a href={s.url} target="_blank" rel="noreferrer noopener">
                    Open sign-in page
                  </a>
                )}
              </div>
            );
          case "delegation":
            return (
              <div key={i} className="notice">
                Delegated to {s.peerBotId}: {s.status}
                {s.summary ? ` — ${s.summary}` : ""}
              </div>
            );
          default:
            return null;
        }
      })}
      {live && !run.segments.length && <p className="small muted cursor">Starting</p>}
      {run.status === "failed" && <div className="error-box small">The turn failed: {run.error?.message}</div>}
      {run.status === "interrupted" && <div className="notice">The turn was interrupted ({run.error?.message}). Send a message to continue.</div>}
      {run.status === "cancelled" && <div className="small muted">Stopped.</div>}
      {run.written.length > 0 && (
        <div className="small muted" title={run.written.map((w) => w.content).join("\n")}>
          Remembered: {run.written.map((w) => w.content).join("; ")}
        </div>
      )}
      {!live && (
        <div className="run-foot">
          {run.usage.turnDurationMs !== undefined && <span>{duration(run.usage.turnDurationMs)}</span>}
          {run.usage.totalTokens !== undefined && <span>{num(run.usage.totalTokens)} tokens</span>}
          {credits(run.usage) > 0 && <span>{credits(run.usage).toFixed(2)} credits</span>}
          {onFeedback && (
            <span className="row" style={{ gap: 2 }}>
              <button className="btn ghost sm" aria-pressed={rated === 1} aria-label="Good response" onClick={() => (setRated(1), onFeedback(1))}>
                Helpful
              </button>
              <button className="btn ghost sm" aria-pressed={rated === -1} aria-label="Bad response" onClick={() => (setRated(-1), onFeedback(-1))}>
                Not helpful
              </button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
