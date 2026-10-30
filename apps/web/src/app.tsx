import { useCallback, useEffect, useState } from "react";
import { Link, NavLink, Outlet, createBrowserRouter, createMemoryRouter, RouterProvider, useLocation, useNavigate, useOutletContext } from "react-router";
import { apiPromise, auth, config, isPrototype, onUnauthorized, type OrreryApi, type Principal } from "./api";
import { Backdrop } from "./components/Backdrop";
import { Orb, OrbStack, Wave } from "./components/Orb";
import { Dialog, OrreryMark } from "./components/ui";
import { useFleet } from "./lib/fleet";
import { ApiProvider, useApi, useCan, useLoad } from "./lib/hooks";
import { setActivity } from "./lib/mood";
import { useTheme } from "./lib/theme";
import { ApprovalsPage } from "./pages/Approvals";
import { BotSettingsPage } from "./pages/BotSettings";
import { BotChat, GroupChat } from "./pages/Chat";
import { HomePage } from "./pages/Home";
import { KnowledgePage } from "./pages/Knowledge";
import { MemoryPage } from "./pages/Memory";
import { PlatformPage } from "./pages/Platform";
import { RoutinesPage } from "./pages/Routines";
import { SettingsPage } from "./pages/Settings";

function Shell() {
  const { pulse } = useApi();
  const canWrite = useCan("member");
  const { bots, activity, approvals } = useFleet();
  const groups = useLoad((a) => a.listGroups(), [pulse]);
  const [open, setOpen] = useState(false);
  const [newGroup, setNewGroup] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  // Let the room feel the bots: how many are working, whether anyone waits on you.
  const values = Object.values(activity);
  const working = values.filter((a) => a === "working").length;
  const waiting = values.filter((a) => a === "waiting").length;
  useEffect(() => setActivity(working, waiting), [working, waiting]);

  const sub = (id: string, description: string) => {
    const a = activity[id];
    if (a === "working")
      return (
        <div className="convo-sub">
          <Wave /> working
        </div>
      );
    if (a === "waiting") return <div className="convo-sub waiting">waiting for you</div>;
    if (a === "paused") return <div className="convo-sub">paused</div>;
    return <div className="convo-sub">{description}</div>;
  };

  return (
    <>
      <div className="shell">
        <div className="mobile-bar glass">
          <button className="btn ghost sm" onClick={() => setOpen(true)} aria-label="Open conversations">
            Menu
          </button>
          <Link to="/" className="wordmark">
            <OrreryMark size={20} />
            orrery
          </Link>
          {approvals.length > 0 && (
            <Link to="/approvals" className="count" aria-label={`${approvals.length} waiting for you`}>
              {approvals.length}
            </Link>
          )}
        </div>
        <aside className={`rail glass ${open ? "open" : ""}`} aria-label="Conversations">
          <div className="spread">
            <NavLink to="/" className="wordmark" end>
              <OrreryMark />
              orrery
            </NavLink>
            <button className="btn ghost sm mobile-only rail-close" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
          <div className="rail-scroll">
            <div className="rail-group">
              <div className="rail-label">
                <span>Bots</span>
                {canWrite && (
                  <Link to="/bots/new" aria-label="New bot" title="New bot">
                    +
                  </Link>
                )}
              </div>
              {bots.map((b) => (
                <NavLink key={b.id} to={`/bots/${b.id}`} className="convo-link">
                  <Orb id={b.id} name={b.name} avatar={b.avatar ?? null} activity={activity[b.id]} />
                  <span style={{ minWidth: 0 }}>
                    <div className="convo-name">{b.name}</div>
                    {sub(b.id, b.description)}
                  </span>
                </NavLink>
              ))}
            </div>
            <div className="rail-group">
              <div className="rail-label">
                <span>Groups</span>
                {canWrite && bots.length > 0 && (
                  <button onClick={() => setNewGroup(true)} aria-label="New group" title="New group">
                    +
                  </button>
                )}
              </div>
              {groups.data?.map((g) => {
                const busy = g.members.some((m) => activity[m.botId] === "working");
                const waiting = g.members.some((m) => activity[m.botId] === "waiting");
                return (
                  <NavLink key={g.id} to={`/groups/${g.id}`} className="convo-link">
                    <OrbStack members={g.members} size="sm" />
                    <span style={{ minWidth: 0 }}>
                      <div className="convo-name">{g.name}</div>
                      {waiting ? (
                        <div className="convo-sub waiting">waiting for you</div>
                      ) : busy ? (
                        <div className="convo-sub">
                          <Wave /> working
                        </div>
                      ) : (
                        <div className="convo-sub">{g.members.map((m) => m.name).join(", ")}</div>
                      )}
                    </span>
                  </NavLink>
                );
              })}
              {!groups.data?.length && <p className="small faint" style={{ padding: "0 12px", margin: 0 }}>Bots that work together, in one conversation.</p>}
            </div>
          </div>
          <div className="rail-foot">
            {approvals.length > 0 && (
              <NavLink to="/approvals">
                Waiting for you <span className="count">{approvals.length}</span>
              </NavLink>
            )}
            <NavLink to="/settings">Settings</NavLink>
          </div>
        </aside>
        <main className="main" onClick={() => open && setOpen(false)}>
          {isPrototype && <div className="proto-banner glass">Prototype on simulated data. Approve Scout's pull request, write to the incidents group, or message Ada while she works.</div>}
          <Outlet context={{ newGroup: () => setNewGroup(true) }} />
        </main>
      </div>
      <NewGroupDialog open={newGroup} onClose={() => setNewGroup(false)} onCreated={() => groups.reload()} />
    </>
  );
}

function NewGroupDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const { api, toast } = useApi();
  const { bots } = useFleet();
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [ids, setIds] = useState<string[]>([]);
  const create = async () => {
    try {
      const g = await api.createGroup({ name: name.trim(), botIds: ids });
      onCreated();
      onClose();
      setName("");
      setIds([]);
      nav(`/groups/${g.id}`);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="New group">
      <form onSubmit={(e) => (e.preventDefault(), void create())}>
        <h2>New group</h2>
        <p className="small muted" style={{ margin: 0 }}>
          Up to six bots in one conversation. The first one you pick leads: it answers when no one is mentioned. Mention a bot with @ to ask it directly; bots hand work to each other the same way.
        </p>
        <label className="field">
          <span>Name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="incidents" autoFocus />
        </label>
        <div className="field">
          <span>Bots</span>
          {bots
            .filter((b) => b.status !== "archived")
            .map((b) => {
              const i = ids.indexOf(b.id);
              return (
                <label key={b.id} className="check">
                  <input type="checkbox" checked={i >= 0} disabled={i < 0 && ids.length >= 6} onChange={(e) => setIds((x) => (e.target.checked ? [...x, b.id] : x.filter((y) => y !== b.id)))} />
                  <Orb id={b.id} name={b.name} avatar={b.avatar ?? null} size="sm" />
                  <span className="grow">{b.name}</span>
                  {i === 0 && <span className="chip">leads</span>}
                </label>
              );
            })}
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!name.trim() || !ids.length}>
            Create group
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function Home() {
  const { newGroup } = useOutletContext<{ newGroup: () => void }>();
  return <HomePage onNewGroup={newGroup} />;
}

function NotFound() {
  return (
    <div className="page glass">
      <h1>Nothing here</h1>
      <p className="muted">
        The link may be out of date. <NavLink to="/">Go home</NavLink>.
      </p>
    </div>
  );
}

const routes = [
  {
    path: "/",
    element: <Shell />,
    children: [
      { index: true, element: <Home /> },
      { path: "approvals", element: <ApprovalsPage /> },
      { path: "memory", element: <MemoryPage /> },
      { path: "knowledge", element: <KnowledgePage /> },
      { path: "routines", element: <RoutinesPage /> },
      { path: "platform", element: <PlatformPage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "bots/new", element: <BotSettingsPage /> },
      { path: "bots/:botId", element: <BotChat /> },
      { path: "bots/:botId/t/:threadId", element: <BotChat /> },
      { path: "bots/:botId/settings", element: <BotSettingsPage /> },
      { path: "groups/:groupId", element: <GroupChat /> },
      { path: "*", element: <NotFound /> },
    ],
  },
];
// The prototype is embedded as a single page: keep navigation in memory instead of the URL.
const router = isPrototype ? createMemoryRouter(routes) : createBrowserRouter(routes);

function Login({ error, onToken }: { error: string | null; onToken: (t: string) => void }) {
  const [token, setToken] = useState("");
  return (
    <div className="login">
      <div style={{ width: "min(440px, 100%)" }}>
        <h1>orrery</h1>
        <div className="login-card glass">
          <h2>Sign in</h2>
          {error && <div className="error-box small">{error}</div>}
          {auth.configured && (
            <button className="btn primary" onClick={() => void auth.login()}>
              Continue with single sign-on
            </button>
          )}
          <form className="stack" onSubmit={(e) => (e.preventDefault(), onToken(token.trim()))}>
            <label className="field">
              <span>{auth.configured ? "Or use a token" : "Admin token or API token"}</span>
              <input className="input mono" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoFocus={!auth.configured} />
            </label>
            <button className={`btn ${auth.configured ? "" : "primary"}`} disabled={!token.trim()}>
              Sign in
            </button>
          </form>
          <p className="xs muted" style={{ margin: 0 }}>
            On Kubernetes the admin token is in the platform secret: <code>kubectl get secret orrery-platform -o jsonpath='&#123;.data.admin-token&#125;' | base64 -d</code>
          </p>
        </div>
      </div>
    </div>
  );
}

function Themed({ children }: { children: React.ReactNode }) {
  const [, resolved] = useTheme();
  return (
    <>
      <Backdrop theme={resolved} />
      {children}
    </>
  );
}

export function App() {
  const [api, setApi] = useState<OrreryApi | null>(null);
  const [me, setMe] = useState<Principal | null>(null);
  const [needLogin, setNeedLogin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Array<{ id: number; text: string; tone: "info" | "error" }>>([]);

  const toast = useCallback((text: string, tone: "info" | "error" = "info") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "error" ? 7000 : 3500);
  }, []);

  const boot = useCallback(async () => {
    try {
      const next = await auth.handleCallback();
      if (next) history.replaceState(null, "", next);
      const a = await apiPromise;
      setApi(a);
      if (a.mode === "live" && !(await auth.token())) {
        setNeedLogin(true);
        return;
      }
      setMe(await a.me());
      setNeedLogin(false);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 401 || status === 403) {
        auth.logout();
        setNeedLogin(true);
        setError(status === 403 ? "Your account doesn't have access to a team." : "That token isn't valid, or it was revoked.");
      } else setError(`Can't reach the Orrery API${config.apiUrl ? ` at ${config.apiUrl}` : ""}: ${(e as Error).message}`);
    }
  }, []);

  useEffect(() => {
    onUnauthorized(() => setNeedLogin(true));
    void boot();
  }, [boot]);

  if (needLogin)
    return (
      <Themed>
        <Login error={error} onToken={(t) => (auth.useDeveloperToken(t), setError(null), void boot())} />
      </Themed>
    );
  if (error && !me)
    return (
      <Themed>
        <div className="login">
          <div className="login-card glass">
            <div className="error-box">{error}</div>
          </div>
        </div>
      </Themed>
    );
  if (!api || !me) return <Themed>{null}</Themed>;
  return (
    <Themed>
      <ApiProvider api={api} me={me} toast={toast}>
        <RouterProvider router={router} />
        <div className="toast-wrap" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.tone}`}>
              {t.text}
            </div>
          ))}
        </div>
      </ApiProvider>
    </Themed>
  );
}
