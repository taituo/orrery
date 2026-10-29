import { useState } from "react";
import { Link } from "react-router";
import type { Routine } from "../api";
import { Avatar, Dialog, Empty, ErrorBox, Seg } from "../components/ui";
import { describeSchedule, relTime } from "../lib/format";
import { useApi, useCan, useLoad } from "../lib/hooks";

export function RoutinesPage() {
  const { api, toast } = useApi();
  const canWrite = useCan("member");
  const q = useLoad(async (a) => {
    const [routines, bots] = await Promise.all([a.listRoutines(), a.listBots()]);
    return { routines, bots: new Map(bots.map((b) => [b.id, b])) };
  }, []);
  const [editing, setEditing] = useState<Routine | "new" | null>(null);
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast(msg);
      q.reload();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Routines</h1>
          <p>Scheduled work. Each routine is a durable schedule that sends its prompt to a teammate; missed runs during downtime are caught up once, never doubled.</p>
        </div>
        {canWrite && (
          <button className="btn primary" onClick={() => setEditing("new")}>
            New routine
          </button>
        )}
      </div>
      <ErrorBox error={q.error} />
      {!q.loading && !q.data?.routines.length ? (
        <Empty title="No routines yet" action={canWrite ? <button className="btn primary" onClick={() => setEditing("new")}>Create a routine</button> : undefined}>
          Try a morning health check, a weekly cost report, or a nightly docs sync.
        </Empty>
      ) : (
        <div className="panel">
          <table className="table responsive">
            <thead>
              <tr>
                <th>Routine</th>
                <th>Teammate</th>
                <th>Schedule</th>
                <th>Last run</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data?.routines.map((r) => {
                const bot = q.data!.bots.get(r.botId);
                return (
                  <tr key={r.id} style={r.enabled ? undefined : { opacity: 0.65 }}>
                    <td>
                      <strong>{r.name}</strong>
                      <div className="small muted" style={{ maxWidth: "60ch" }}>
                        {r.prompt}
                      </div>
                    </td>
                    <td>
                      {bot && (
                        <Link to={`/bots/${bot.id}`} className="row" style={{ textDecoration: "none", color: "inherit" }}>
                          <Avatar bot={bot} size="sm" /> {bot.name}
                        </Link>
                      )}
                    </td>
                    <td className="small">
                      {describeSchedule(r.schedule)}
                      {!r.enabled && <div className="chip dashed" style={{ marginTop: 4 }}>Paused</div>}
                    </td>
                    <td className="small muted">{relTime(r.lastRunAt)}</td>
                    <td>
                      {canWrite && (
                        <div className="row">
                          <button className="btn sm" onClick={() => void act(() => api.runRoutine(r.id), `${r.name} started.`)}>
                            Run now
                          </button>
                          <button className="btn sm ghost" onClick={() => void act(() => api.updateRoutine(r.id, { enabled: !r.enabled }), r.enabled ? "Routine paused." : "Routine resumed.")}>
                            {r.enabled ? "Pause" : "Resume"}
                          </button>
                          <button className="btn sm ghost" onClick={() => setEditing(r)}>
                            Edit
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {editing && <RoutineDialog routine={editing === "new" ? null : editing} bots={[...(q.data?.bots.values() ?? [])]} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), q.reload())} />}
    </div>
  );
}

function RoutineDialog({ routine, bots, onClose, onSaved }: { routine: Routine | null; bots: Array<{ id: string; name: string }>; onClose: () => void; onSaved: () => void }) {
  const { api, toast } = useApi();
  const [f, setF] = useState({
    botId: routine?.botId ?? bots[0]?.id ?? "",
    name: routine?.name ?? "",
    prompt: routine?.prompt ?? "",
    kind: (routine?.schedule.intervalMinutes ? "interval" : "cron") as "cron" | "interval",
    cron: routine?.schedule.cron ?? "50 6 * * 1-5",
    interval: routine?.schedule.intervalMinutes ?? 60,
    timezone: routine?.schedule.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    threadPolicy: routine?.threadPolicy ?? "reuse",
  });
  const schedule = f.kind === "cron" ? { cron: f.cron, timezone: f.timezone } : { intervalMinutes: f.interval, timezone: f.timezone };
  const save = async () => {
    try {
      if (routine) await api.updateRoutine(routine.id, { name: f.name, prompt: f.prompt, schedule, threadPolicy: f.threadPolicy });
      else await api.createRoutine({ botId: f.botId, name: f.name, prompt: f.prompt, schedule, threadPolicy: f.threadPolicy, enabled: true });
      toast(routine ? "Routine saved." : "Routine created.");
      onSaved();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  return (
    <Dialog open onClose={onClose} title={routine ? "Edit routine" : "New routine"}>
      <form onSubmit={(e) => (e.preventDefault(), void save())}>
        <h2>{routine ? "Edit routine" : "New routine"}</h2>
        {!routine && (
          <label className="field">
            <span>Teammate</span>
            <select className="select" value={f.botId} onChange={(e) => setF({ ...f, botId: e.target.value })}>
              {bots.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span>Name</span>
          <input className="input" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Morning cluster check" />
        </label>
        <label className="field">
          <span>What to do</span>
          <textarea className="textarea" required rows={4} value={f.prompt} onChange={(e) => setF({ ...f, prompt: e.target.value })} />
        </label>
        <Seg label="Schedule type" value={f.kind} onChange={(kind) => setF({ ...f, kind })} options={[{ value: "cron", label: "At set times" }, { value: "interval", label: "Every few minutes" }]} />
        <div className="two">
          {f.kind === "cron" ? (
            <label className="field">
              <span>Cron expression</span>
              <input className="input mono" value={f.cron} onChange={(e) => setF({ ...f, cron: e.target.value })} />
              <small>{describeSchedule({ cron: f.cron, timezone: f.timezone })}</small>
            </label>
          ) : (
            <label className="field">
              <span>Every (minutes)</span>
              <input className="input" type="number" min={1} value={f.interval} onChange={(e) => setF({ ...f, interval: Number(e.target.value) })} />
            </label>
          )}
          <label className="field">
            <span>Time zone</span>
            <input className="input" value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} />
          </label>
        </div>
        <label className="field">
          <span>Conversation</span>
          <select className="select" value={f.threadPolicy} onChange={(e) => setF({ ...f, threadPolicy: e.target.value as "new" | "reuse" })}>
            <option value="reuse">Continue the same conversation each run</option>
            <option value="new">Start a new conversation each run</option>
          </select>
        </label>
        <div className="row" style={{ justifyContent: "space-between" }}>
          {routine ? (
            <button type="button" className="btn danger" onClick={() => void api.deleteRoutine(routine.id).then(onSaved)}>
              Delete routine
            </button>
          ) : (
            <span />
          )}
          <div className="row">
            <button type="button" className="btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={!f.name || !f.prompt}>
              {routine ? "Save routine" : "Create routine"}
            </button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
