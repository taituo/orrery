import { Link } from "react-router";
import { Orrery } from "../components/Orrery";
import { Avatar, Empty, ErrorBox } from "../components/ui";
import { engineLabel } from "../lib/format";
import { useFleet } from "../lib/fleet";
import { useCan, useLoad } from "../lib/hooks";

export function FleetPage() {
  const { bots, active, approvals, activity, error, loading } = useFleet();
  const usage = useLoad((api) => api.usage(30), []);
  const canCreate = useCan("admin");
  const spend = new Map<string, { credits: number; usd: number }>();
  for (const u of usage.data ?? []) {
    const s = spend.get(u.botId) ?? { credits: 0, usd: 0 };
    spend.set(u.botId, { credits: s.credits + u.credits, usd: s.usd + u.costUsd });
  }
  const spendLabel = (id: string) => {
    const s = spend.get(id);
    if (!s) return "No usage";
    return [s.credits ? `${s.credits.toFixed(1)} credits` : "", s.usd ? `$${s.usd.toFixed(2)}` : ""].filter(Boolean).join(" + ") || "No usage";
  };
  const working = Object.values(activity).filter((a) => a === "working").length;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Fleet</h1>
          <p>
            {loading && !bots.length
              ? "Loading teammates…"
              : `${bots.length} teammates. ${working ? `${working} working right now` : "Nobody is working right now"}${approvals.length ? `, ${approvals.length} waiting on you.` : "."}`}
          </p>
        </div>
        {canCreate && (
          <Link className="btn primary" to="/bots/new">
            New teammate
          </Link>
        )}
      </div>
      <ErrorBox error={error} />
      {!loading && !bots.length ? (
        <Empty title="No teammates yet" action={canCreate ? <Link className="btn primary" to="/bots/new">Create your first teammate</Link> : undefined}>
          A teammate is an always-on agent with its own computer, memory and tools. Create one to start delegating work.
        </Empty>
      ) : (
        <div className="fleet">
          <Orrery bots={bots} activity={activity} />
          <div className="bot-rows">
            {bots.map((b) => {
              const act = activity[b.id] ?? "idle";
              const pending = approvals.filter((a) => a.botId === b.id);
              const runs = active.filter((r) => r.botId === b.id);
              return (
                <Link key={b.id} to={`/bots/${b.id}`} className="bot-row">
                  <Avatar bot={b} activity={act} />
                  <div style={{ minWidth: 0 }}>
                    <div className="row wrap">
                      <span className="bot-name">{b.name}</span>
                      <span className="chip">{engineLabel(b.primary)}</span>
                      {b.routing.mode === "auto" && b.routing.fast && <span className="chip">Fast replies: {b.routing.fast.model}</span>}
                    </div>
                    <div className="small muted" style={{ marginTop: 2 }}>
                      {b.description}
                    </div>
                    <div className="activity">
                      {act === "paused" && "Paused. Messages and routines are held until you resume."}
                      {act === "waiting" && (
                        <>
                          Needs your approval: <b>{pending[0]?.title}</b>
                          {pending.length > 1 ? ` and ${pending.length - 1} more` : ""}
                        </>
                      )}
                      {act === "working" && <>Working on {runs.length === 1 ? "a conversation" : `${runs.length} conversations`}</>}
                      {act === "idle" && "Idle"}
                    </div>
                  </div>
                  <div className="small muted nowrap" style={{ textAlign: "right" }}>
                    {spendLabel(b.id)}
                    <div className="xs faint">last 30 days</div>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
