import { useEffect, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router";
import type { Bot, BotCreate } from "../api";
import { ErrorBox, Seg } from "../components/ui";
import { useApi, useCan, useLoad } from "../lib/hooks";

type Form = Omit<Bot, "id" | "teamId" | "createdAt" | "updatedAt">;
type PrimaryKind = "kiro-v3" | "kiro-v2" | "kiro-auto" | "acp" | "openai";

const blank = (): Form => ({
  name: "",
  description: "",
  instructions: "",
  primary: { kind: "kiro-acp", engine: "v3", authMethod: "cli" },
  routing: { mode: "fixed", agentThreshold: 0.35 },
  policy: { defaultEffect: "ask", rules: [], guardrail: { enabled: true, askAbove: 0.5, denyAbove: 0.92 }, approvalTimeoutMinutes: 1440, allowPersistentConsent: true },
  computer: { enabled: true, size: "small", idleMinutes: 60, persistentHome: true, shared: false, network: { mode: "restricted", allow: [] } },
  memory: { enabled: true, autoExtract: true, recallK: 8, shareScope: "bot", coreMemoryCharLimit: 4000 },
  knowledgeBaseIds: [],
  mcpServers: [],
  peers: [],
  status: "active",
});

function Section({ title, help, children }: { title: string; help: string; children: ReactNode }) {
  return (
    <>
      <div className="form-section-label">
        <h2>{title}</h2>
        <p>{help}</p>
      </div>
      <div className="form-section-body">{children}</div>
    </>
  );
}

export function BotSettingsPage() {
  const { botId } = useParams();
  const isNew = !botId;
  const nav = useNavigate();
  const { api, toast } = useApi();
  const isAdmin = useCan("admin");
  const existing = useLoad((a) => (botId ? a.getBot(botId) : Promise.resolve(null)), [], botId ?? "new");
  const refs = useLoad(async (a) => {
    const [providers, kbs, bots, secrets] = await Promise.all([a.providers(), a.listKnowledgeBases(), a.listBots(), a.listSecrets().catch(() => [])]);
    return { providers: providers.providers, kbs, bots, secrets };
  }, []);
  const [f, setF] = useState<Form>(blank);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  useEffect(() => {
    if (existing.data?.bot) {
      const { id: _i, teamId: _t, createdAt: _c, updatedAt: _u, ...rest } = existing.data.bot;
      setF(rest);
    }
  }, [existing.data]);

  const chatProviders = (refs.data?.providers ?? []).filter((p) => p.kind === "openai" && (p.roles.includes("chat") || p.roles.includes("fast")));
  const modelsOf = (id: string) => ((refs.data?.providers.find((p) => p.id === id)?.models.chat as string[] | undefined) ?? []);
  const pk: PrimaryKind = f.primary.kind === "kiro-acp" ? (`kiro-${f.primary.engine}` as PrimaryKind) : f.primary.kind;
  const setPrimaryKind = (k: PrimaryKind) => {
    if (k.startsWith("kiro-")) setF({ ...f, primary: { kind: "kiro-acp", engine: k.slice(5) as "v3" | "v2" | "auto", authMethod: "cli", ...(f.primary.kind === "kiro-acp" ? { modeId: f.primary.modeId, modelId: f.primary.modelId, effort: f.primary.effort } : {}) } as Form["primary"] });
    else if (k === "openai") setF({ ...f, primary: { kind: "openai", providerId: chatProviders[0]?.id ?? "", model: modelsOf(chatProviders[0]?.id ?? "")[0] ?? "", maxSteps: 12 } });
    else setF({ ...f, primary: { kind: "acp", command: "", args: [] } });
  };
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const body = f as unknown as BotCreate;
      const bot = isNew ? await api.createBot(body) : await api.updateBot(botId!, body);
      toast(isNew ? `${bot.name} is ready.` : "Settings saved.");
      nav(`/bots/${bot.id}`);
    } catch (e) {
      setErr(e as Error);
    } finally {
      setSaving(false);
    }
  };

  if (!isNew && !existing.data) return <div className="page muted">{existing.error ? <ErrorBox error={existing.error} /> : "Loading…"}</div>;
  const ro = !isAdmin;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{isNew ? "New teammate" : `${f.name} settings`}</h1>
          <p>{isNew ? "Give it a job, an inference engine, and the guardrails it works within." : "Changes apply from the next turn. Running turns keep the settings they started with."}</p>
        </div>
        {!isNew && isAdmin && (
          <div className="row">
            <button className="btn" onClick={() => void api.updateBot(botId!, { status: f.status === "paused" ? "active" : "paused" }).then((b) => (setF({ ...f, status: b.status }), toast(b.status === "paused" ? `${b.name} paused.` : `${b.name} resumed.`)))}>
              {f.status === "paused" ? "Resume" : "Pause"}
            </button>
            <button
              className="btn"
              onClick={() =>
                void api.webhookToken(botId!).then((w) => {
                  void navigator.clipboard?.writeText(`curl -X POST ${w.url} -H 'Authorization: Bearer ${w.token}' -H 'content-type: application/json' -d '{"text":"…"}'`);
                  toast("Webhook command copied to the clipboard.");
                })
              }
            >
              Copy webhook
            </button>
          </div>
        )}
      </div>
      <ErrorBox error={err ?? refs.error} />
      <fieldset disabled={ro} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="form-grid">
          <Section title="Identity" help="How the teammate introduces itself and what it's for.">
            <div className="two">
              <label className="field">
                <span>Name</span>
                <input className="input" required value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Ada" />
              </label>
              <label className="field">
                <span>Initials</span>
                <input className="input" maxLength={2} value={f.avatar ?? ""} onChange={(e) => set("avatar", e.target.value)} placeholder={f.name[0] ?? "A"} />
              </label>
            </div>
            <label className="field">
              <span>Job description</span>
              <input className="input" value={f.description} onChange={(e) => set("description", e.target.value)} placeholder="On-call platform engineer for staging and production." />
            </label>
            <label className="field">
              <span>Standing instructions</span>
              <textarea className="textarea" rows={6} value={f.instructions} onChange={(e) => set("instructions", e.target.value)} placeholder="How it should work, what to avoid, how to report." />
              <small>Sent as the system prompt (OpenAI-compatible) or as Kiro steering on the bot computer.</small>
            </label>
          </Section>

          <Section title="Inference" help="Kiro over the Agent Client Protocol does the real work; an OpenAI-compatible model can answer quick questions.">
            <label className="field">
              <span>Engine</span>
              <select className="select" value={pk} onChange={(e) => setPrimaryKind(e.target.value as PrimaryKind)}>
                <option value="kiro-v3">Kiro CLI V3 (ACP, recommended)</option>
                <option value="kiro-v2">Kiro CLI v2 (ACP, legacy)</option>
                <option value="kiro-auto">Kiro CLI, detect version</option>
                <option value="acp">Another ACP agent</option>
                <option value="openai">OpenAI-compatible model only</option>
              </select>
            </label>
            {f.primary.kind === "kiro-acp" && (
              <>
                <div className="three">
                  <label className="field">
                    <span>{f.primary.engine === "v2" ? "Agent" : "Mode"}</span>
                    <input className="input" value={f.primary.modeId ?? ""} onChange={(e) => set("primary", { ...f.primary, modeId: e.target.value || undefined } as Form["primary"])} placeholder={f.primary.engine === "v2" ? "kiro_default" : "vibe"} />
                  </label>
                  <label className="field">
                    <span>Model</span>
                    <input className="input" value={f.primary.modelId ?? ""} onChange={(e) => set("primary", { ...f.primary, modelId: e.target.value || undefined } as Form["primary"])} placeholder="auto" />
                  </label>
                  <label className="field">
                    <span>Effort</span>
                    <select className="select" value={f.primary.effort ?? ""} onChange={(e) => set("primary", { ...f.primary, effort: e.target.value || undefined } as Form["primary"])}>
                      <option value="">Agent default</option>
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                    </select>
                  </label>
                </div>
                <p className="xs faint" style={{ margin: 0 }}>
                  {f.primary.engine === "v2"
                    ? "v2 takes the agent and model as launch flags and switches models with session/set_model."
                    : "Values are checked against what the agent advertises when the session starts; unknown modes or models are reported, never invented."}
                </p>
                {f.primary.engine !== "v2" && (
                  <label className="field">
                    <span>Kiro sign-in</span>
                    <select className="select" value={f.primary.authMethod} onChange={(e) => set("primary", { ...f.primary, authMethod: e.target.value as "cli" | "client" } as Form["primary"])}>
                      <option value="cli">The CLI's own login (API key on the bot computer)</option>
                      <option value="client">Orrery supplies tokens (client auth method)</option>
                    </select>
                  </label>
                )}
              </>
            )}
            {f.primary.kind === "acp" && (
              <label className="field">
                <span>Command</span>
                <input className="input mono" value={f.primary.command} onChange={(e) => set("primary", { ...f.primary, command: e.target.value } as Form["primary"])} placeholder="gemini --experimental-acp" />
              </label>
            )}
            {f.primary.kind === "openai" && (
              <div className="two">
                <label className="field">
                  <span>Provider</span>
                  <select className="select" value={f.primary.providerId} onChange={(e) => set("primary", { ...f.primary, providerId: e.target.value, model: modelsOf(e.target.value)[0] ?? "" } as Form["primary"])}>
                    {chatProviders.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.id}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Model</span>
                  <input className="input" list="models" value={f.primary.model} onChange={(e) => set("primary", { ...f.primary, model: e.target.value } as Form["primary"])} />
                  <datalist id="models">{f.primary.kind === "openai" && modelsOf(f.primary.providerId).map((m) => <option key={m} value={m} />)}</datalist>
                </label>
              </div>
            )}
            {f.primary.kind !== "openai" && (
              <>
                <Seg
                  label="Routing"
                  value={f.routing.mode}
                  onChange={(mode) => set("routing", { ...f.routing, mode, ...(mode === "auto" && !f.routing.fast ? { fast: { kind: "openai", providerId: chatProviders[0]?.id ?? "", model: modelsOf(chatProviders[0]?.id ?? "")[0] ?? "", maxSteps: 8 } } : {}) })}
                  options={[{ value: "fixed", label: "Always use the agent" }, { value: "auto", label: "Answer quick questions with a small model" }]}
                />
                {f.routing.mode === "auto" && f.routing.fast && (
                  <div className="three">
                    <label className="field">
                      <span>Fast provider</span>
                      <select className="select" value={f.routing.fast.providerId} onChange={(e) => set("routing", { ...f.routing, fast: { ...f.routing.fast!, providerId: e.target.value, model: modelsOf(e.target.value)[0] ?? "" } })}>
                        {chatProviders.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.id}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>Fast model</span>
                      <input className="input" value={f.routing.fast.model} onChange={(e) => set("routing", { ...f.routing, fast: { ...f.routing.fast!, model: e.target.value } })} />
                    </label>
                    <label className="field">
                      <span>Use the agent when likelihood ≥ {Math.round(f.routing.agentThreshold * 100)}%</span>
                      <input type="range" min={0.05} max={0.95} step={0.05} value={f.routing.agentThreshold} onChange={(e) => set("routing", { ...f.routing, agentThreshold: Number(e.target.value) })} />
                    </label>
                  </div>
                )}
              </>
            )}
          </Section>

          <Section title="Tools and approvals" help="Rules are checked in order of strictness: deny beats ask beats allow. The Clef guardrail can only make a decision stricter.">
            <div className="two">
              <label className="field">
                <span>When no rule matches</span>
                <select className="select" value={f.policy.defaultEffect} onChange={(e) => set("policy", { ...f.policy, defaultEffect: e.target.value as "allow" | "ask" | "deny" })}>
                  <option value="ask">Ask a person</option>
                  <option value="allow">Allow</option>
                  <option value="deny">Deny</option>
                </select>
              </label>
              <label className="field">
                <span>Approvals expire after (hours)</span>
                <input className="input" type="number" min={1} value={Math.round(f.policy.approvalTimeoutMinutes / 60)} onChange={(e) => set("policy", { ...f.policy, approvalTimeoutMinutes: Math.max(1, Number(e.target.value)) * 60 })} />
              </label>
            </div>
            <table className="rules">
              <thead>
                <tr>
                  <th>Effect</th>
                  <th>Capability</th>
                  <th>Matches</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {f.policy.rules.map((r, i) => (
                  <tr key={r.id}>
                    <td style={{ width: 110 }}>
                      <select className="select" value={r.effect} onChange={(e) => set("policy", { ...f.policy, rules: f.policy.rules.map((x, j) => (j === i ? { ...x, effect: e.target.value as "allow" | "ask" | "deny" } : x)) })} aria-label="Effect">
                        <option value="allow">Allow</option>
                        <option value="ask">Ask</option>
                        <option value="deny">Deny</option>
                      </select>
                    </td>
                    <td style={{ width: 120 }}>
                      <select className="select" value={r.capability} onChange={(e) => set("policy", { ...f.policy, rules: f.policy.rules.map((x, j) => (j === i ? { ...x, capability: e.target.value } : x)) })} aria-label="Capability">
                        {["*", "shell", "read", "write", "edit", "delete", "move", "fetch", "search", "mcp", "platform", "other"].map((c) => (
                          <option key={c} value={c}>
                            {c === "*" ? "anything" : c}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input className="input mono" value={r.resource} onChange={(e) => set("policy", { ...f.policy, rules: f.policy.rules.map((x, j) => (j === i ? { ...x, resource: e.target.value } : x)) })} aria-label="Resource pattern" />
                    </td>
                    <td style={{ width: 40 }}>
                      <button type="button" className="btn ghost sm" aria-label="Remove rule" onClick={() => set("policy", { ...f.policy, rules: f.policy.rules.filter((_, j) => j !== i) })}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row wrap">
              <button type="button" className="btn sm" onClick={() => set("policy", { ...f.policy, rules: [...f.policy.rules, { id: `rule-${Date.now().toString(36)}`, effect: "ask", capability: "shell", resource: "**" }] })}>
                Add rule
              </button>
              <span className="xs faint">Patterns: <code>*</code> within a path segment, <code>**</code> across, <code>{"{a,b}"}</code> alternatives. Commands match the whole command line.</span>
            </div>
            <label className="check">
              <input type="checkbox" checked={f.policy.guardrail.enabled} onChange={(e) => set("policy", { ...f.policy, guardrail: { ...f.policy.guardrail, enabled: e.target.checked } })} />
              Risk guardrail: have Clef score each tool call and escalate risky ones
            </label>
            {f.policy.guardrail.enabled && (
              <div className="two">
                <label className="field">
                  <span>Ask a person above {Math.round(f.policy.guardrail.askAbove * 100)}% risk</span>
                  <input type="range" min={0.1} max={0.95} step={0.05} value={f.policy.guardrail.askAbove} onChange={(e) => set("policy", { ...f.policy, guardrail: { ...f.policy.guardrail, askAbove: Number(e.target.value) } })} />
                </label>
                <label className="field">
                  <span>Deny outright above {Math.round(f.policy.guardrail.denyAbove * 100)}% risk</span>
                  <input type="range" min={0.5} max={1} step={0.01} value={f.policy.guardrail.denyAbove} onChange={(e) => set("policy", { ...f.policy, guardrail: { ...f.policy.guardrail, denyAbove: Number(e.target.value) } })} />
                </label>
              </div>
            )}
            <label className="check">
              <input type="checkbox" checked={f.policy.allowPersistentConsent} onChange={(e) => set("policy", { ...f.policy, allowPersistentConsent: e.target.checked })} />
              Let admins grant standing permission ("always allow") when the agent offers it
            </label>
          </Section>

          <Section title="Computer" help="Each teammate gets a sandboxed pod with a persistent home directory, where Kiro runs and keeps its workspace.">
            <label className="check">
              <input type="checkbox" checked={f.computer.enabled} onChange={(e) => set("computer", { ...f.computer, enabled: e.target.checked })} />
              Give this teammate a computer
            </label>
            {f.computer.enabled && (
              <>
                <div className="three">
                  <label className="field">
                    <span>Size</span>
                    <select className="select" value={f.computer.size} onChange={(e) => set("computer", { ...f.computer, size: e.target.value as "small" | "medium" | "large" })}>
                      <option value="small">Small (1 CPU, 2 GiB)</option>
                      <option value="medium">Medium (2 CPU, 4 GiB)</option>
                      <option value="large">Large (4 CPU, 8 GiB)</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>Stop after idle (minutes)</span>
                    <input className="input" type="number" min={5} value={f.computer.idleMinutes} onChange={(e) => set("computer", { ...f.computer, idleMinutes: Number(e.target.value) })} />
                  </label>
                  <label className="field">
                    <span>Network</span>
                    <select className="select" value={f.computer.network.mode} onChange={(e) => set("computer", { ...f.computer, network: { ...f.computer.network, mode: e.target.value as "restricted" | "open" | "none" } })}>
                      <option value="restricted">Allowlisted hosts only</option>
                      <option value="open">Open internet</option>
                      <option value="none">No network</option>
                    </select>
                  </label>
                </div>
                {f.computer.network.mode === "restricted" && (
                  <label className="field">
                    <span>Allowed hosts</span>
                    <textarea className="textarea mono" rows={3} value={f.computer.network.allow.join("\n")} onChange={(e) => set("computer", { ...f.computer, network: { ...f.computer.network, allow: e.target.value.split(/\s+/).filter(Boolean) } })} placeholder={"github.com\n*.githubusercontent.com"} />
                    <small>One per line. Kiro's own endpoints and the Orrery platform are always reachable.</small>
                  </label>
                )}
                <label className="check">
                  <input type="checkbox" checked={f.computer.persistentHome} onChange={(e) => set("computer", { ...f.computer, persistentHome: e.target.checked })} />
                  Keep the home directory between restarts
                </label>
              </>
            )}
          </Section>

          <Section title="Memory" help="Long-term memory is extracted after each turn, screened for secrets, and reconciled with what the teammate already knows.">
            <label className="check">
              <input type="checkbox" checked={f.memory.enabled} onChange={(e) => set("memory", { ...f.memory, enabled: e.target.checked })} />
              Remember things between conversations
            </label>
            {f.memory.enabled && (
              <>
                <label className="check">
                  <input type="checkbox" checked={f.memory.autoExtract} onChange={(e) => set("memory", { ...f.memory, autoExtract: e.target.checked })} />
                  Learn automatically from conversations
                </label>
                <div className="three">
                  <label className="field">
                    <span>Memories recalled per turn</span>
                    <input className="input" type="number" min={0} max={50} value={f.memory.recallK} onChange={(e) => set("memory", { ...f.memory, recallK: Number(e.target.value) })} />
                  </label>
                  <label className="field">
                    <span>Shared with</span>
                    <select className="select" value={f.memory.shareScope} onChange={(e) => set("memory", { ...f.memory, shareScope: e.target.value as "bot" | "team" })}>
                      <option value="bot">Only this teammate</option>
                      <option value="team">Also read the team's shared memories</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>Core memory limit (characters)</span>
                    <input className="input" type="number" min={200} max={20000} value={f.memory.coreMemoryCharLimit} onChange={(e) => set("memory", { ...f.memory, coreMemoryCharLimit: Number(e.target.value) })} />
                  </label>
                </div>
              </>
            )}
          </Section>

          <Section title="Knowledge and tools" help="Knowledge bases it can search, extra MCP servers, and teammates it can hand work to.">
            <div className="field">
              <span>Knowledge bases</span>
              <div className="row wrap">
                {refs.data?.kbs.map((k) => (
                  <label key={k.id} className="check">
                    <input type="checkbox" checked={f.knowledgeBaseIds.includes(k.id)} onChange={(e) => set("knowledgeBaseIds", e.target.checked ? [...f.knowledgeBaseIds, k.id] : f.knowledgeBaseIds.filter((x) => x !== k.id))} />
                    {k.name}
                  </label>
                ))}
                {!refs.data?.kbs.length && <span className="small muted">None yet.</span>}
              </div>
            </div>
            <div className="field">
              <span>MCP servers</span>
              {f.mcpServers.map((s, i) => (
                <div key={i} className="row">
                  <input className="input" style={{ width: 140 }} value={s.name} onChange={(e) => set("mcpServers", f.mcpServers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} aria-label="Server name" />
                  {s.type === "stdio" ? (
                    <input className="input mono grow" value={s.command} onChange={(e) => set("mcpServers", f.mcpServers.map((x, j) => (j === i ? { ...x, command: e.target.value } : x)) as Form["mcpServers"])} aria-label="Command" />
                  ) : (
                    <input className="input mono grow" value={s.url} onChange={(e) => set("mcpServers", f.mcpServers.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) as Form["mcpServers"])} aria-label="URL" />
                  )}
                  <span className="chip">{s.type}</span>
                  <button type="button" className="btn ghost sm" onClick={() => set("mcpServers", f.mcpServers.filter((_, j) => j !== i))}>
                    Remove
                  </button>
                </div>
              ))}
              <div className="row">
                <button type="button" className="btn sm" onClick={() => set("mcpServers", [...f.mcpServers, { type: "http", name: "server", url: "https://", headers: [] }])}>
                  Add HTTP server
                </button>
                <button type="button" className="btn sm" onClick={() => set("mcpServers", [...f.mcpServers, { type: "stdio", name: "local", command: "npx", args: [], env: [] }])}>
                  Add local command
                </button>
              </div>
              <small>
                Header values can reference stored secrets as <code>secret://name</code>
                {refs.data?.secrets.length ? ` (${refs.data.secrets.map((s) => s.name).join(", ")})` : ""}. Local commands run on the bot computer only.
              </small>
            </div>
            <div className="field">
              <span>Can hand work to</span>
              <div className="row wrap">
                {refs.data?.bots
                  .filter((b) => b.id !== botId)
                  .map((b) => (
                    <label key={b.id} className="check">
                      <input type="checkbox" checked={f.peers.includes(b.id)} onChange={(e) => set("peers", e.target.checked ? [...f.peers, b.id] : f.peers.filter((x) => x !== b.id))} />
                      {b.name}
                    </label>
                  ))}
              </div>
            </div>
          </Section>
        </div>
      </fieldset>
      {isAdmin && (
        <div className="sticky-actions">
          {!isNew && (
            <button className="btn danger" style={{ marginRight: "auto" }} onClick={() => void api.archiveBot(botId!).then(() => (toast(`${f.name} archived.`), nav("/")))}>
              Archive teammate
            </button>
          )}
          <button className="btn ghost" onClick={() => nav(-1)}>
            Cancel
          </button>
          <button className="btn primary" disabled={!f.name || saving} onClick={() => void save()}>
            {saving ? "Saving…" : isNew ? "Create teammate" : "Save settings"}
          </button>
        </div>
      )}
    </div>
  );
}
