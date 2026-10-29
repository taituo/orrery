import { useEffect, useState } from "react";
import type { KnowledgeHit, KnowledgeSource } from "../api";
import { Dialog, Empty, ErrorBox, Seg } from "../components/ui";
import { num, relTime } from "../lib/format";
import { useApi, useCan, useLoad } from "../lib/hooks";

export function KnowledgePage() {
  const { api, toast } = useApi();
  const canWrite = useCan("member");
  const canAdmin = useCan("admin");
  const kbs = useLoad((a) => a.listKnowledgeBases(), []);
  const [kbId, setKbId] = useState<string>("");
  useEffect(() => {
    if (!kbId && kbs.data?.length) setKbId(kbs.data[0]!.id);
  }, [kbs.data, kbId]);
  const sources = useLoad((a) => (kbId ? a.listSources(kbId) : Promise.resolve([] as KnowledgeSource[])), [], kbId);
  const ingesting = sources.data?.some((s) => s.status === "pending" || s.status === "ingesting");
  useEffect(() => {
    if (!ingesting) return;
    const t = setInterval(sources.reload, 1500);
    return () => clearInterval(t);
  }, [ingesting, sources.reload]);

  const [adding, setAdding] = useState(false);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{ hits: KnowledgeHit[]; sufficient: boolean | null } | null>(null);
  const kb = kbs.data?.find((k) => k.id === kbId);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Knowledge</h1>
          <p>Documents teammates can search. Sources are chunked, embedded and screened for prompt injection before they're indexed; answers only use passages that actually support them.</p>
        </div>
        {canAdmin && (
          <button className="btn" onClick={() => setCreating(true)}>
            New knowledge base
          </button>
        )}
      </div>
      <ErrorBox error={kbs.error ?? sources.error} />
      {!kbs.loading && !kbs.data?.length ? (
        <Empty title="No knowledge bases" action={canAdmin ? <button className="btn primary" onClick={() => setCreating(true)}>Create a knowledge base</button> : undefined}>
          Add runbooks, docs or policies so teammates can cite them.
        </Empty>
      ) : (
        <>
          <div className="row wrap" style={{ marginBottom: 16 }}>
            {kbs.data?.map((k) => (
              <button key={k.id} className={`btn ${k.id === kbId ? "primary" : ""}`} onClick={() => (setKbId(k.id), setResult(null))}>
                {k.name}
              </button>
            ))}
          </div>
          {kb && (
            <div className="stack" style={{ gap: 20 }}>
              <div className="panel">
                <div className="panel-head">
                  <div>
                    <strong>{kb.name}</strong>
                    <div className="xs muted">
                      {kb.description} Embeddings: {kb.embeddingModel || "provider default"}, chunks of {kb.chunkSize} characters.
                    </div>
                  </div>
                  {canWrite && (
                    <button className="btn primary sm" onClick={() => setAdding(true)}>
                      Add source
                    </button>
                  )}
                </div>
                {sources.data?.length ? (
                  <table className="table responsive">
                    <thead>
                      <tr>
                        <th>Source</th>
                        <th>Status</th>
                        <th className="num">Chunks</th>
                        <th>Updated</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {sources.data.map((s) => (
                        <tr key={s.id}>
                          <td>
                            <div>{s.title}</div>
                            <div className="xs faint mono" style={{ overflowWrap: "anywhere" }}>
                              {s.uri}
                            </div>
                            {s.error && <div className="xs" style={{ color: "var(--red)", marginTop: 4 }}>{s.error}</div>}
                          </td>
                          <td>
                            <span className={`chip ${s.status === "ready" ? "green" : s.status === "failed" ? "red" : "dashed"}`}>{{ pending: "Queued", ingesting: "Indexing", ready: "Ready", failed: "Failed" }[s.status]}</span>
                          </td>
                          <td className="num">
                            {num(s.stats.chunks)}
                            {s.stats.rejected ? <div className="xs faint">{s.stats.rejected} screened out</div> : null}
                          </td>
                          <td className="small muted">{relTime(s.updatedAt)}</td>
                          <td>
                            {canWrite && (
                              <div className="row">
                                <button className="btn sm ghost" onClick={() => void api.reingest(s.id).then(sources.reload)}>
                                  Re-index
                                </button>
                                <button className="btn sm ghost" onClick={() => void api.deleteSource(s.id).then(() => (toast("Source removed."), sources.reload()))}>
                                  Remove
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="panel-body">
                    <Empty title="No sources yet">Add a URL, paste text, or upload a PDF, Markdown or HTML file.</Empty>
                  </div>
                )}
              </div>

              <div className="panel">
                <div className="panel-head">
                  <strong>Try a search</strong>
                </div>
                <div className="panel-body stack">
                  <form
                    className="row"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (query) void api.searchKnowledge([kb.id], query).then(setResult, (err: Error) => toast(err.message, "error"));
                    }}
                  >
                    <input className="input grow" placeholder="How do I restart the api on staging?" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search query" />
                    <button className="btn">Search</button>
                  </form>
                  {result && (
                    <>
                      <p className="small muted" style={{ margin: 0 }}>
                        {result.sufficient === true ? "These passages are enough to answer the question." : result.sufficient === false ? "These passages are related but don't fully answer the question." : "No answerability check was made."}
                      </p>
                      {result.hits.length ? (
                        <ol style={{ margin: 0, paddingLeft: 18 }} className="stack">
                          {result.hits.map((h) => (
                            <li key={h.chunkId}>
                              <strong className="small">{h.sourceTitle}</strong>
                              {h.heading && <span className="xs muted"> / {h.heading}</span>}
                              <div className="small">{h.content}</div>
                            </li>
                          ))}
                        </ol>
                      ) : (
                        <p className="small muted">No passages found.</p>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          )}
        </>
      )}
      <AddSourceDialog open={adding} kbId={kbId} onClose={() => setAdding(false)} onAdded={() => (setAdding(false), sources.reload())} />
      <CreateKbDialog open={creating} onClose={() => setCreating(false)} onCreated={(id) => (setCreating(false), kbs.reload(), setKbId(id))} />
    </div>
  );
}

function AddSourceDialog({ open, kbId, onClose, onAdded }: { open: boolean; kbId: string; onClose: () => void; onAdded: () => void }) {
  const { api, toast } = useApi();
  const [type, setType] = useState<"url" | "text" | "upload">("url");
  const [uri, setUri] = useState("");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api.addSource(kbId, type === "url" ? { type, uri, ...(title ? { title } : {}) } : type === "text" ? { type, title, text } : { type, file: file! });
      toast("Source added. Indexing has started.");
      setUri("");
      setTitle("");
      setText("");
      setFile(null);
      onAdded();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  const valid = type === "url" ? /^https?:\/\//.test(uri) : type === "text" ? Boolean(title && text) : Boolean(file);
  return (
    <Dialog open={open} onClose={onClose} title="Add source">
      <form method="dialog" onSubmit={(e) => (e.preventDefault(), void submit())}>
        <h2>Add source</h2>
        <Seg label="Source type" value={type} onChange={setType} options={[{ value: "url", label: "Web page" }, { value: "text", label: "Paste text" }, { value: "upload", label: "Upload file" }]} />
        {type === "url" && (
          <>
            <label className="field">
              <span>URL</span>
              <input className="input" type="url" required value={uri} onChange={(e) => setUri(e.target.value)} placeholder="https://wiki.example.com/runbooks/api" />
            </label>
            <label className="field">
              <span>Title (optional)</span>
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
          </>
        )}
        {type === "text" && (
          <>
            <label className="field">
              <span>Title</span>
              <input className="input" required value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label className="field">
              <span>Text or Markdown</span>
              <textarea className="textarea" rows={8} required value={text} onChange={(e) => setText(e.target.value)} />
            </label>
          </>
        )}
        {type === "upload" && (
          <label className="field">
            <span>File</span>
            <input className="input" type="file" accept=".pdf,.md,.markdown,.txt,.html,.htm,.json,.csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <small>PDF, Markdown, HTML, text, JSON or CSV up to 25 MB.</small>
          </label>
        )}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!valid || busy}>
            {busy ? "Adding…" : "Add source"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function CreateKbDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const { api, toast } = useApi();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  return (
    <Dialog open={open} onClose={onClose} title="New knowledge base">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void api.createKnowledgeBase({ name, description }).then((kb) => (setName(""), setDescription(""), onCreated(kb.id)), (err: Error) => toast(err.message, "error"));
        }}
      >
        <h2>New knowledge base</h2>
        <label className="field">
          <span>Name</span>
          <input className="input" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Runbooks" />
        </label>
        <label className="field">
          <span>Description</span>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Operational runbooks for staging and production." />
        </label>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!name}>
            Create knowledge base
          </button>
        </div>
      </form>
    </Dialog>
  );
}
