import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import type { MemoryItem, MemoryKind, RecallResult } from "../api";
import { Empty, ErrorBox } from "../components/ui";
import { relTime } from "../lib/format";
import { useApi, useCan, useLoad } from "../lib/hooks";

const KINDS: MemoryKind[] = ["fact", "preference", "instruction", "entity", "procedure", "episode_summary"];
const kindLabel = (k: string) => (k === "episode_summary" ? "episode" : k);
const BLOCKS = [
  { key: "persona", label: "Persona", help: "Who the bot is and how it works. Always in context." },
  { key: "human", label: "About the team", help: "What it should always know about the people it works with." },
  { key: "notes", label: "Working notes", help: "Scratchpad the agent edits itself with core_memory tools." },
] as const;

export function MemoryPage() {
  const { api, toast } = useApi();
  const canWrite = useCan("member");
  const [params, setParams] = useSearchParams();
  const bots = useLoad((a) => a.listBots(), []);
  const botId = params.get("bot") ?? bots.data?.[0]?.id ?? "";
  const bot = bots.data?.find((b) => b.id === botId);
  const [kind, setKind] = useState<MemoryKind | "">("");
  const [q, setQ] = useState("");
  const [history, setHistory] = useState(false);
  const mems = useLoad((a) => (botId ? a.listMemories({ botId, ...(kind ? { kind } : {}), ...(q ? { q } : {}), includeSuperseded: history }) : Promise.resolve([])), [kind, q, history], botId);
  const core = useLoad((a) => (botId ? a.coreMemory(botId) : Promise.resolve(null)), [], botId);
  const [draft, setDraft] = useState<Record<string, string>>({});
  useEffect(() => setDraft(core.data ?? {}), [core.data]);
  const [probe, setProbe] = useState("");
  const [recall, setRecall] = useState<RecallResult[] | null>(null);
  const [teach, setTeach] = useState({ kind: "fact" as MemoryKind, content: "" });
  const limit = bot?.memory.coreMemoryCharLimit ?? 4000;

  const saveBlock = async (block: "persona" | "human" | "notes") => {
    try {
      await api.setCoreMemory(botId, block, draft[block] ?? "");
      toast("Core memory saved.");
      core.reload();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  const doTeach = async () => {
    try {
      const r = await api.writeMemory(botId, { kind: teach.kind, content: teach.content });
      toast(r.action === "skipped" ? (r.reason === "sensitive" ? "Not saved: it looks like a secret. Store credentials as secrets instead." : "Not saved.") : r.action === "updated" ? "Already known — refreshed the existing memory." : "Saved to memory.", r.action === "skipped" ? "error" : "info");
      if (r.action !== "skipped") setTeach({ ...teach, content: "" });
      mems.reload();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  const patch = async (m: MemoryItem, p: Partial<MemoryItem>) => {
    try {
      await api.updateMemory(m.id, p);
      mems.reload();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Memory</h1>
          <p>What each bot remembers between conversations. Core memory is always in context; long-term memories are recalled when relevant and kept current — newer facts replace contradicted ones instead of piling up.</p>
        </div>
        <div className="row">
          <label className="field" style={{ minWidth: 180 }}>
            <span>Bot</span>
            <select className="select" value={botId} onChange={(e) => setParams({ bot: e.target.value })}>
              {bots.data?.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          {canWrite && (
            <button className="btn" style={{ alignSelf: "flex-end" }} onClick={() => void api.consolidate(botId).then(() => (toast("Consolidation started."), mems.reload()))}>
              Consolidate now
            </button>
          )}
        </div>
      </div>
      <ErrorBox error={mems.error ?? core.error} />

      <h2 style={{ marginBottom: 10 }}>Core memory</h2>
      <div className="core-grid" style={{ marginBottom: 28 }}>
        {BLOCKS.map((b) => {
          const v = draft[b.key] ?? "";
          const dirty = v !== (core.data?.[b.key] ?? "");
          return (
            <div key={b.key} className="panel">
              <div className="panel-head">
                <strong>{b.label}</strong>
                <span className={`xs ${v.length > limit ? "" : "faint"}`} style={v.length > limit ? { color: "var(--red)" } : undefined}>
                  {v.length} / {limit}
                </span>
              </div>
              <div className="panel-body stack" style={{ gap: 8 }}>
                <p className="xs muted" style={{ margin: 0 }}>
                  {b.help}
                </p>
                <textarea className="textarea" rows={6} value={v} readOnly={!canWrite} onChange={(e) => setDraft({ ...draft, [b.key]: e.target.value })} aria-label={b.label} />
                {canWrite && (
                  <div className="row">
                    <button className="btn sm primary" disabled={!dirty || v.length > limit} onClick={() => void saveBlock(b.key)}>
                      Save
                    </button>
                    {dirty && (
                      <button className="btn sm ghost" onClick={() => setDraft({ ...draft, [b.key]: core.data?.[b.key] ?? "" })}>
                        Discard
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="two" style={{ marginBottom: 20, alignItems: "start" }}>
        {canWrite && (
          <div className="panel">
            <div className="panel-head">
              <strong>Teach {bot?.name ?? "this bot"} something</strong>
            </div>
            <div className="panel-body stack">
              <div className="row">
                <select className="select" style={{ width: 160 }} value={teach.kind} onChange={(e) => setTeach({ ...teach, kind: e.target.value as MemoryKind })} aria-label="Kind">
                  {KINDS.filter((k) => k !== "episode_summary").map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
                <input className="input grow" placeholder="e.g. Staging deploys freeze on Fridays after 15:00" value={teach.content} onChange={(e) => setTeach({ ...teach, content: e.target.value })} onKeyDown={(e) => e.key === "Enter" && teach.content && void doTeach()} aria-label="Memory" />
                <button className="btn primary" disabled={!teach.content.trim()} onClick={() => void doTeach()}>
                  Save
                </button>
              </div>
              <p className="xs faint" style={{ margin: 0 }}>
                Secrets are never stored as memories. Duplicates refresh the existing memory.
              </p>
            </div>
          </div>
        )}
        <div className="panel">
          <div className="panel-head">
            <strong>Test recall</strong>
          </div>
          <div className="panel-body stack">
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                if (probe) void api.recall(botId, probe).then(setRecall);
              }}
            >
              <input className="input grow" placeholder="Ask what the bot would remember…" value={probe} onChange={(e) => setProbe(e.target.value)} aria-label="Recall query" />
              <button className="btn">Recall</button>
            </form>
            {recall && (recall.length ? (
              <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
                {recall.slice(0, 5).map((r) => (
                  <li key={r.id}>
                    {r.content} <span className="faint xs">{r.score.toFixed(2)}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="small muted" style={{ margin: 0 }}>Nothing relevant would be recalled.</p>
            ))}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head" style={{ flexWrap: "wrap" }}>
          <strong>Long-term memories</strong>
          <div className="row wrap">
            <input className="input" style={{ width: 200 }} placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter memories" />
            <select className="select" style={{ width: 150 }} value={kind} onChange={(e) => setKind(e.target.value as MemoryKind | "")} aria-label="Kind filter">
              <option value="">All kinds</option>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {kindLabel(k)}
                </option>
              ))}
            </select>
            <label className="check small">
              <input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} /> Show replaced
            </label>
          </div>
        </div>
        {mems.data?.length ? (
          mems.data.map((m) => (
            <div key={m.id} className={`mem-row ${m.supersededBy ? "superseded" : ""}`}>
              <div className="stack" style={{ gap: 4 }}>
                <span className="chip" style={{ alignSelf: "flex-start" }}>{kindLabel(m.kind)}</span>
                {m.scope === "team" && <span className="chip dashed" style={{ alignSelf: "flex-start" }}>team-wide</span>}
              </div>
              <div style={{ minWidth: 0 }}>
                <div className="mem-content">{m.content}</div>
                <div className="xs faint" style={{ marginTop: 4 }}>
                  {m.supersededBy ? `Replaced ${relTime(m.validTo)}. ` : ""}
                  {{ turn: "Learned in conversation", user: "Taught by a person", import: "Imported", consolidation: "From consolidation", tool: "Saved by the agent" }[m.source.type]}, {relTime(m.createdAt)}. Recalled {m.accessCount} times.
                </div>
              </div>
              <div className="row">
                <label className="xs muted" title="Importance">
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    className="importance"
                    defaultValue={m.importance}
                    disabled={!canWrite || Boolean(m.supersededBy)}
                    onPointerUp={(e) => void patch(m, { importance: Number(e.currentTarget.value) })}
                    onKeyUp={(e) => void patch(m, { importance: Number(e.currentTarget.value) })}
                    aria-label="Importance"
                  />
                </label>
                {canWrite && !m.supersededBy && (
                  <>
                    <button className="btn sm ghost" aria-pressed={m.pinned} onClick={() => void patch(m, { pinned: !m.pinned })}>
                      {m.pinned ? "Pinned" : "Pin"}
                    </button>
                    <button className="btn sm ghost" onClick={() => void api.forgetMemory(m.id).then(() => (toast("Forgotten."), mems.reload()))}>
                      Forget
                    </button>
                  </>
                )}
              </div>
            </div>
          ))
        ) : (
          <div className="panel-body">
            <Empty title={q || kind ? "No memories match" : "No long-term memories yet"}>Bots learn from conversations automatically when auto-extract is on.</Empty>
          </div>
        )}
      </div>
    </div>
  );
}
