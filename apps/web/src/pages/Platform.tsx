import { useState } from "react";
import { Link } from "react-router";
import { Empty, ErrorBox, Tabs } from "../components/ui";
import { engineLabel, num, relTime } from "../lib/format";
import { useApi, useCan, useLoad } from "../lib/hooks";

type Tab = "providers" | "usage" | "computers" | "secrets" | "audit";

export function PlatformPage() {
  const isAdmin = useCan("admin");
  const [tab, setTab] = useState<Tab>("providers");
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Platform</h1>
          <p>Model providers, spend, bot computers, secrets and the audit trail.</p>
        </div>
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "providers", label: "Providers" },
          { value: "usage", label: "Usage" },
          { value: "computers", label: "Computers" },
          ...(isAdmin ? [{ value: "secrets" as const, label: "Secrets" }, { value: "audit" as const, label: "Audit log" }] : []),
        ]}
      />
      <div style={{ marginTop: 20 }}>
        {tab === "providers" && <Providers />}
        {tab === "usage" && <Usage />}
        {tab === "computers" && <Computers />}
        {tab === "secrets" && <Secrets />}
        {tab === "audit" && <Audit />}
      </div>
    </div>
  );
}

const ROLE_LABEL: Record<string, string> = { chat: "chat", fast: "quick replies", extract: "memory extraction", summarize: "summaries", embed: "embeddings", rerank: "reranking", decide: "decisions and guardrails" };

function Providers() {
  const { api } = useApi();
  const isAdmin = useCan("admin");
  const q = useLoad((a) => a.providers(), []);
  const [tests, setTests] = useState<Record<string, string>>({});
  const test = async (id: string) => {
    setTests((t) => ({ ...t, [id]: "Testing…" }));
    try {
      const r = await api.testProvider(id);
      setTests((t) => ({ ...t, [id]: r.ok ? `Reachable in ${r.latencyMs} ms` : "Not reachable" }));
    } catch (e) {
      setTests((t) => ({ ...t, [id]: (e as Error).message }));
    }
  };
  return (
    <div className="stack">
      <div className="panel">
        <div className="panel-head">
          <strong>Kiro over ACP</strong>
          <span className="chip blue">Primary inference</span>
        </div>
        <div className="panel-body small">
          <p>Runs inside each bot's computer through the Orrery ACP gateway, which keeps the agent process alive across worker restarts and replays held permission requests. Both the CLI V3 engine (<code>kiro-cli acp --agent-engine=v3</code>) and the legacy CLI v2 are supported; "detect version" falls back to v2 when V3 flags are rejected.</p>
          <p className="muted" style={{ margin: 0 }}>Kiro needs an API key on the bot computers: set <code>KIRO_API_KEY</code> in <Link to="/settings">Settings</Link>, or put it in the cluster's <code>orrery-kiro</code> secret.</p>
        </div>
      </div>
      <div className="panel">
        <div className="panel-head">
          <strong>OpenCode over ACP</strong>
          <span className="chip">Coding agent</span>
        </div>
        <div className="panel-body small">
          <p>Runs <code>opencode acp</code> in the bot's computer behind the same gateway. It can use the OpenAI-compatible providers below (as <code>orrery-&lt;id&gt;/&lt;model&gt;</code>) or any provider OpenCode supports. With Orrery permissions every tool call is asked over ACP and decided by the bot's policy; project config in the workspace is ignored so the agent can't grant itself permissions.</p>
          <p className="muted" style={{ margin: 0 }}>Model credentials (<code>ANTHROPIC_API_KEY</code>, provider keys) come from the agent environment secret on the bot computers.</p>
        </div>
      </div>
      <ErrorBox error={q.error} />
      <div className="panel">
        <table className="table responsive">
          <thead>
            <tr>
              <th>Provider</th>
              <th>Used for</th>
              <th>Models</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.data?.providers.map((p) => (
              <tr key={p.id}>
                <td>
                  <strong>{p.id}</strong>
                  <div className="xs muted">{p.kind === "clef" ? "Cloudflare Clef (System One API)" : "OpenAI-compatible"}</div>
                  {q.data?.decisions === p.id && <span className="chip blue" style={{ marginTop: 4 }}>Decision model</span>}
                </td>
                <td className="small">{p.roles.map((r) => ROLE_LABEL[r] ?? r).join(", ")}</td>
                <td className="small mono">
                  {Object.entries(p.models)
                    .filter(([, v]) => v && (!Array.isArray(v) || v.length))
                    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`)
                    .join("\n")
                    .split("\n")
                    .map((l) => (
                      <div key={l}>{l}</div>
                    ))}
                </td>
                <td>
                  {isAdmin && (
                    <div className="row">
                      <button className="btn sm" onClick={() => void test(p.id)}>
                        Test
                      </button>
                      {tests[p.id] && <span className="xs muted">{tests[p.id]}</span>}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="xs faint">Providers are configured in the deployment (providers.yaml / Helm values), so they're versioned with the rest of the platform.</p>
    </div>
  );
}

function Usage() {
  const [days, setDays] = useState(30);
  const q = useLoad(async (a) => {
    const [rows, bots] = await Promise.all([a.usage(days), a.listBots()]);
    return { rows, bots: new Map(bots.map((b) => [b.id, b])) };
  }, [days]);
  const rows = q.data?.rows ?? [];
  const maxTokens = Math.max(1, ...rows.map((r) => r.inputTokens + r.outputTokens));
  const totalCredits = rows.reduce((s, r) => s + r.credits, 0);
  const totalCost = rows.reduce((s, r) => s + r.costUsd, 0);
  return (
    <div className="stack">
      <div className="spread">
        <p className="muted" style={{ margin: 0 }}>
          {totalCredits.toFixed(1)} Kiro credits and ${totalCost.toFixed(2)} on OpenAI-compatible models in the last {days} days.
        </p>
        <select className="select" style={{ width: 150 }} value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period">
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>
      <ErrorBox error={q.error} />
      <div className="panel">
        <table className="table responsive">
          <thead>
            <tr>
              <th>Bot</th>
              <th>Provider</th>
              <th className="num">Turns</th>
              <th style={{ width: "30%" }}>Tokens</th>
              <th className="num">Credits</th>
              <th className="num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const bot = q.data!.bots.get(r.botId);
              const tokens = r.inputTokens + r.outputTokens;
              return (
                <tr key={`${r.botId}-${r.provider}`}>
                  <td>{bot?.name ?? r.botId}</td>
                  <td className="small">{r.provider === "kiro-acp" || r.provider === "opencode-acp" ? (bot ? engineLabel(bot.primary) : r.provider === "kiro-acp" ? "Kiro" : "OpenCode") : r.provider === "acp" ? "ACP agent" : "OpenAI-compatible"}</td>
                  <td className="num">{num(r.runs)}</td>
                  <td>
                    <div className="row">
                      <div className="meter grow">
                        <i style={{ width: `${(tokens / maxTokens) * 100}%` }} />
                      </div>
                      <span className="xs muted nowrap" style={{ width: 52, textAlign: "right" }}>
                        {num(tokens)}
                      </span>
                    </div>
                  </td>
                  <td className="num">{r.credits ? r.credits.toFixed(1) : "–"}</td>
                  <td className="num">{r.costUsd ? `$${r.costUsd.toFixed(2)}` : "–"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rows.length && !q.loading && (
          <div className="panel-body">
            <Empty title="No usage in this period" />
          </div>
        )}
      </div>
    </div>
  );
}

function Computers() {
  const q = useLoad(async (a) => {
    const [computers, bots] = await Promise.all([a.computers(), a.listBots()]);
    return { computers, bots: new Map(bots.map((b) => [b.id, b])) };
  }, []);
  return (
    <div className="panel">
      <ErrorBox error={q.error} />
      {q.data?.computers.length ? (
        <table className="table responsive">
          <thead>
            <tr>
              <th>Computer</th>
              <th>Bot</th>
              <th>Agent</th>
              <th>Status</th>
              <th>Last active</th>
            </tr>
          </thead>
          <tbody>
            {q.data.computers.map((c) => (
              <tr key={c.id}>
                <td className="mono small">{c.id}</td>
                <td>{c.botId ? (q.data!.bots.get(c.botId)?.name ?? c.botId) : "Shared"}</td>
                <td className="small">{{ "kiro-v3": "Kiro CLI V3", "kiro-v2": "Kiro CLI v2", "kiro-auto": "Kiro CLI (detect)", opencode: "OpenCode", acp: "ACP agent" }[c.agentKind] ?? c.agentKind}</td>
                <td>
                  <span className={`chip ${c.status === "ready" ? "green" : c.status === "failed" ? "red" : "dashed"}`}>{c.status}</span>
                </td>
                <td className="small muted">{relTime(c.lastActiveAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="panel-body">
          <Empty title="No computers running">They start on a bot's first turn and stop after the idle timeout.</Empty>
        </div>
      )}
    </div>
  );
}

function Secrets() {
  const { api, toast } = useApi();
  const q = useLoad((a) => a.listSecrets(), []);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  return (
    <div className="stack">
      <div className="panel">
        <div className="panel-head">
          <strong>Add or replace a secret</strong>
        </div>
        <form
          className="panel-body row wrap"
          onSubmit={(e) => {
            e.preventDefault();
            void api.putSecret(name, value).then(
              () => (toast(`Saved secret ${name}.`), setName(""), setValue(""), q.reload()),
              (err: Error) => toast(err.message, "error"),
            );
          }}
        >
          <input className="input mono" style={{ width: 200 }} placeholder="github-token" value={name} onChange={(e) => setName(e.target.value.replace(/[^a-z0-9._-]/gi, "-"))} aria-label="Secret name" required />
          <input className="input grow" type="password" autoComplete="off" placeholder="Value" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Secret value" required />
          <button className="btn primary" disabled={!name || !value}>
            Save secret
          </button>
        </form>
      </div>
      <div className="panel">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Reference</th>
              <th>Saved</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.data?.map((s) => (
              <tr key={s.name}>
                <td className="mono">{s.name}</td>
                <td className="mono small muted">secret://{s.name}</td>
                <td className="small muted">{relTime(s.createdAt)}</td>
                <td>
                  <button className="btn sm ghost" onClick={() => void api.deleteSecret(s.name).then(q.reload)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="xs faint">Values are encrypted at rest and only decrypted inside workers when a session starts. They can't be read back here.</p>
    </div>
  );
}

function Audit() {
  const q = useLoad((a) => a.audit(), []);
  return (
    <div className="panel">
      <ErrorBox error={q.error} />
      <table className="table responsive">
        <thead>
          <tr>
            <th>When</th>
            <th>Who</th>
            <th>What</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {q.data?.map((e, i) => (
            <tr key={e.id ?? i}>
              <td className="small muted nowrap">{relTime(e.created_at ?? e.at)}</td>
              <td className="small">{e.actor}</td>
              <td>
                <code className="small">{e.action}</code>
                {e.target && <div className="xs faint mono">{e.target}</div>}
              </td>
              <td className="xs muted mono" style={{ overflowWrap: "anywhere" }}>
                {Object.keys(e.data ?? {}).length ? JSON.stringify(e.data) : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
