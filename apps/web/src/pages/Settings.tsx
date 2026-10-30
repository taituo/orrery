import { useState } from "react";
import { Link } from "react-router";
import type { ApiToken, Principal } from "../api";
import { auth, useMock } from "../api";
import { Empty, ErrorBox } from "../components/ui";
import { relTime } from "../lib/format";
import { useApi, useCan, useLoad } from "../lib/hooks";
import { useTheme, type Theme } from "../lib/theme";

const LOOKS: Array<{ value: Theme; label: string; what: string }> = [
  { value: "auto", label: "Automatic", what: "Warm by day, Dusk when your system is dark" },
  { value: "her", label: "Warm", what: "Coral light, slowly moving" },
  { value: "dusk", label: "Dusk", what: "The same room at night" },
  { value: "eclipse", label: "Eclipse", what: "A ring of fire that churns while bots work" },
  { value: "synapse", label: "Synapse", what: "Filaments that fire while bots think" },
  { value: "nebula", label: "Nebula", what: "A glass planet stirring the dark" },
  { value: "wire", label: "Wireframe", what: "Plain white, black lines, nothing moves" },
];

const KNOWN_CREDENTIALS: Array<{ name: string; what: string }> = [
  { name: "KIRO_API_KEY", what: "Kiro bots (Pro, Pro+, Pro Max or Power plan)" },
  { name: "ANTHROPIC_API_KEY", what: "OpenCode bots on anthropic/… models" },
  { name: "OPENAI_API_KEY", what: "OpenCode bots on openai/… models" },
  { name: "OPENROUTER_API_KEY", what: "OpenCode bots on openrouter/… models" },
  { name: "GEMINI_API_KEY", what: "OpenCode bots on google/… models" },
];

export function SettingsPage() {
  const isAdmin = useCan("admin");
  const [theme, , setTheme] = useTheme();
  return (
    <div className="page glass">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Give your bots a model, connect the command line and MCP clients, and choose how Orrery looks.</p>
        </div>
      </div>
      {isAdmin && <Setup />}
      {isAdmin && <Credentials />}
      <Tokens />
      <Connect />
      <div className="panel">
        <div className="panel-head">
          <strong>Appearance</strong>
        </div>
        <div className="panel-body">
          <div className="looks" role="radiogroup" aria-label="Look">
            {LOOKS.map((l) => (
              <button key={l.value} className={`look ${l.value}`} role="radio" aria-checked={theme === l.value} onClick={() => setTheme(l.value)}>
                <span className="look-preview" aria-hidden />
                <span className="look-name">{l.label}</span>
                <span className="look-what">{l.what}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="panel">
        <div className="panel-head">
          <strong>More</strong>
        </div>
        <div className="panel-body row wrap">
          <Link className="btn" to="/memory">
            Memory
          </Link>
          <Link className="btn" to="/knowledge">
            Knowledge
          </Link>
          <Link className="btn" to="/routines">
            Routines
          </Link>
          <Link className="btn" to="/platform">
            Platform
          </Link>
          {!useMock && (
            <button className="btn ghost" onClick={() => (auth.logout(), location.assign("/"))}>
              Sign out
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Setup() {
  const q = useLoad((a) => a.setup(), []);
  if (!q.data) return null;
  const s = q.data;
  const steps = [
    { done: s.agentEnv.length > 0 || s.providers.chat.length > 0, what: "Give bots a model", how: "Set a credential below, or add OpenAI-compatible providers to the install." },
    { done: s.bots > 0, what: "Create a bot", how: <Link to="/bots/new">New bot</Link> },
    { done: s.auth.oidc, what: "Connect your identity provider", how: "Optional: config.oidc in the Helm values. Until then, sign in with the admin token or API tokens." },
  ];
  if (steps.every((x) => x.done)) return null;
  return (
    <div className="panel">
      <div className="panel-head">
        <strong>Getting started</strong>
      </div>
      <div className="panel-body">
        <ul className="checklist">
          {steps.map((x) => (
            <li key={x.what} className={x.done ? "done" : ""}>
              <span className="tick" aria-label={x.done ? "done" : "to do"} />
              <span>
                <span className="what">{x.what}</span>
                {!x.done && <div className="small muted">{x.how}</div>}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Credentials() {
  const { api, toast } = useApi();
  const q = useLoad((a) => a.listAgentEnv(), []);
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [custom, setCustom] = useState("");
  const set = new Map((q.data ?? []).map((v) => [v.name, v]));
  const rows = [...KNOWN_CREDENTIALS, ...(q.data ?? []).filter((v) => !KNOWN_CREDENTIALS.some((k) => k.name === v.name)).map((v) => ({ name: v.name, what: "Custom" }))];

  const save = async (name: string) => {
    try {
      await api.setAgentEnv(name, value);
      toast(`${name} saved. Bot computers restart with it before their next turn.`);
      setEditing(null);
      setValue("");
      setCustom("");
      q.reload();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  const remove = async (name: string) => {
    try {
      await api.deleteAgentEnv(name);
      toast(`${name} removed.`);
      q.reload();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <strong>Agent credentials</strong>
      </div>
      <div className="panel-body">
        <p className="small muted">The keys agents use to reach their models. They are stored encrypted and given only to your team's bot computers. Values are never shown again.</p>
        <ErrorBox error={q.error} />
        {rows.map((r) => (
          <div key={r.name} className="setting-row">
            <div>
              <code>{r.name}</code>
              <div className="small muted">
                {r.what}
                {set.get(r.name) ? `. Set ${relTime(set.get(r.name)!.updatedAt)}.` : ""}
              </div>
              {editing === r.name && (
                <form className="row" style={{ marginTop: 10 }} onSubmit={(e) => (e.preventDefault(), void save(r.name))}>
                  <input className="input mono" type="password" autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder="Paste the key" aria-label={`Value for ${r.name}`} />
                  <button className="btn primary" disabled={!value.trim()}>
                    Save
                  </button>
                  <button type="button" className="btn ghost" onClick={() => (setEditing(null), setValue(""))}>
                    Cancel
                  </button>
                </form>
              )}
            </div>
            {editing !== r.name && (
              <div className="row">
                {set.get(r.name) && (
                  <button className="btn ghost sm danger" onClick={() => void remove(r.name)}>
                    Remove
                  </button>
                )}
                <button className="btn sm" onClick={() => (setEditing(r.name), setValue(""))}>
                  {set.get(r.name) ? "Replace" : "Set"}
                </button>
              </div>
            )}
          </div>
        ))}
        <form className="row" style={{ marginTop: 12 }} onSubmit={(e) => (e.preventDefault(), setEditing(custom.trim().toUpperCase()))}>
          <input className="input mono" value={custom} onChange={(e) => setCustom(e.target.value.toUpperCase())} placeholder="OTHER_VARIABLE" aria-label="Another variable name" />
          <button className="btn" disabled={!/^[A-Z][A-Z0-9_]{1,127}$/.test(custom.trim())}>
            Add variable
          </button>
        </form>
      </div>
    </div>
  );
}

function Tokens() {
  const { api, toast, me } = useApi();
  const isAdmin = useCan("admin");
  const q = useLoad((a) => a.listTokens(), []);
  const [name, setName] = useState("");
  const [role, setRole] = useState<Principal["role"]>(me.role === "owner" ? "member" : me.role);
  const [forUser, setForUser] = useState("");
  const [fresh, setFresh] = useState<{ token: string; apiToken: ApiToken } | null>(null);

  const create = async () => {
    try {
      const r = await api.createToken({ name: name.trim(), role, ...(forUser.trim() ? { forUser: { name: forUser.trim() } } : {}) });
      setFresh(r);
      setName("");
      setForUser("");
      q.reload();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  const roles = (["viewer", "member", "admin", "owner"] as const).filter((r) => ["viewer", "member", "admin", "owner"].indexOf(r) <= ["viewer", "member", "admin", "owner"].indexOf(me.role));

  return (
    <div className="panel">
      <div className="panel-head">
        <strong>API tokens</strong>
      </div>
      <div className="panel-body stack">
        <p className="small muted" style={{ margin: 0 }}>
          For the command line, MCP clients and scripts. A token can do what its role allows, and stops working the moment you revoke it.
        </p>
        {fresh && (
          <div className="stack">
            <div className="token-once">{fresh.token}</div>
            <div className="row">
              <button className="btn sm" onClick={() => void navigator.clipboard?.writeText(fresh.token).then(() => toast("Token copied."))}>
                Copy token
              </button>
              <span className="small muted">Copy it now: it is shown only once.</span>
            </div>
          </div>
        )}
        <form className="row wrap" onSubmit={(e) => (e.preventDefault(), void create())}>
          <input className="input" style={{ flex: "2 1 200px" }} value={name} onChange={(e) => setName(e.target.value)} placeholder="What it's for, e.g. laptop CLI" aria-label="Token name" />
          <select className="select" style={{ flex: "0 1 140px" }} value={role} onChange={(e) => setRole(e.target.value as Principal["role"])} aria-label="Role">
            {roles.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          {isAdmin && <input className="input" style={{ flex: "1 1 150px" }} value={forUser} onChange={(e) => setForUser(e.target.value)} placeholder="For someone else (name)" aria-label="Person" />}
          <button className="btn primary" disabled={!name.trim()}>
            Create token
          </button>
        </form>
        {q.data?.length ? (
          <div>
            {q.data.map((t) => (
              <div key={t.id} className="setting-row">
                <div>
                  <div>
                    {t.name} <span className="chip">{t.role}</span> {t.revokedAt && <span className="chip red">revoked</span>}
                  </div>
                  <div className="small muted">
                    <code>{t.prefix}…</code>
                    {t.userName ? `, for ${t.userName}` : ""}, {t.lastUsedAt ? `used ${relTime(t.lastUsedAt)}` : "never used"}
                  </div>
                </div>
                {!t.revokedAt && (
                  <button className="btn ghost sm danger" onClick={() => void api.revokeToken(t.id).then(() => (toast(`Revoked ${t.name}.`), q.reload()))}>
                    Revoke
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : (
          q.data && <Empty title="No API tokens yet">Create one for the command line or an MCP client.</Empty>
        )}
      </div>
    </div>
  );
}

function Connect() {
  const { toast } = useApi();
  const origin = typeof location !== "undefined" ? location.origin : "https://orrery.example.com";
  const lines = [`curl -fsSLo orrery ${origin}/cli/orrery.mjs && chmod +x orrery`, `./orrery login --url ${origin} --token <token>`];
  const mcp = JSON.stringify({ mcpServers: { orrery: { type: "http", url: `${origin}/mcp`, headers: { Authorization: "Bearer <token>" } } } }, null, 2);
  const copy = (s: string) => void navigator.clipboard?.writeText(s).then(() => toast("Copied."));
  return (
    <div className="panel">
      <div className="panel-head">
        <strong>Command line and MCP</strong>
      </div>
      <div className="panel-body stack">
        <p className="small muted" style={{ margin: 0 }}>
          Talk to your bots and groups from a terminal (Node.js 20 or newer), or from any MCP client such as Claude Desktop, Cursor or VS Code. Use an API token.
        </p>
        {lines.map((l) => (
          <div className="cmd" key={l}>
            <code>{l}</code>
            <button className="btn ghost sm" onClick={() => copy(l)}>
              Copy
            </button>
          </div>
        ))}
        <div className="cmd" style={{ alignItems: "flex-start" }}>
          <pre style={{ flex: 1, minWidth: 0, overflowX: "auto" }}>{mcp}</pre>
          <button className="btn ghost sm" onClick={() => copy(mcp)}>
            Copy
          </button>
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          Then: <code>./orrery chat Ada</code>, <code>./orrery ask incidents "@Scout check the dashboards"</code>, <code>./orrery approvals</code>.
        </p>
      </div>
    </div>
  );
}
