import { useCallback, useEffect, useState } from "react";
import { NavLink, Outlet, createBrowserRouter, createHashRouter, RouterProvider, useLocation } from "react-router";
import { apiPromise, auth, config, isPrototype, onUnauthorized, useMock, type OrreryApi, type Principal } from "./api";
import { OrreryMark, StatusDot } from "./components/ui";
import { useFleet } from "./lib/fleet";
import { ApiProvider, useApi } from "./lib/hooks";
import { ApprovalsPage } from "./pages/Approvals";
import { BotSettingsPage } from "./pages/BotSettings";
import { BotWorkspace } from "./pages/BotWorkspace";
import { FleetPage } from "./pages/Fleet";
import { KnowledgePage } from "./pages/Knowledge";
import { MemoryPage } from "./pages/Memory";
import { PlatformPage } from "./pages/Platform";
import { RoutinesPage } from "./pages/Routines";

type Theme = "system" | "light" | "dark";
const readTheme = (): Theme => {
  try {
    return (localStorage.getItem("orrery.theme") as Theme | null) ?? "system";
  } catch {
    return "system";
  }
};
const applyTheme = (t: Theme) => {
  if (t === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  try {
    localStorage.setItem("orrery.theme", t);
  } catch {
    /* per-viewer convenience only */
  }
};

function Shell() {
  const { me } = useApi();
  const { bots, activity, approvals } = useFleet();
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const loc = useLocation();
  useEffect(() => applyTheme(theme), [theme]);
  useEffect(() => setOpen(false), [loc.pathname]);

  return (
    <div className="shell">
      <div className="mobile-bar">
        <button className="btn sm" onClick={() => setOpen(true)} aria-label="Open navigation">
          Menu
        </button>
        <OrreryMark size={20} />
        <strong>Orrery</strong>
        {approvals.length > 0 && <span className="chip amber">{approvals.length} waiting</span>}
      </div>
      <aside className={`rail ${open ? "open" : ""}`} aria-label="Navigation">
        <NavLink to="/" className="brand" end>
          <OrreryMark />
          Orrery
        </NavLink>
        <nav className="nav">
          <NavLink to="/" end>
            Fleet
          </NavLink>
          <NavLink to="/approvals">
            Approvals
            {approvals.length > 0 && <span className="chip amber">{approvals.length}</span>}
          </NavLink>
          <NavLink to="/memory">Memory</NavLink>
          <NavLink to="/knowledge">Knowledge</NavLink>
          <NavLink to="/routines">Routines</NavLink>
          <NavLink to="/platform">Platform</NavLink>
        </nav>
        <div className="rail-section">Teammates</div>
        <nav className="rail-bots">
          {bots.map((b) => (
            <NavLink key={b.id} to={`/bots/${b.id}`}>
              <StatusDot activity={activity[b.id] ?? "idle"} />
              <span className="grow">{b.name}</span>
            </NavLink>
          ))}
        </nav>
        <div className="rail-foot">
          <span className="grow" title={me.email ?? undefined}>
            {me.name ?? me.userId}
            <span className="faint"> ({me.role})</span>
          </span>
          <select className="select" style={{ width: 84, minHeight: 26, padding: "2px 6px" }} value={theme} onChange={(e) => setTheme(e.target.value as Theme)} aria-label="Theme">
            <option value="system">Auto</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
          {!useMock && (
            <button className="btn ghost sm" onClick={() => (auth.logout(), location.assign("/"))}>
              Sign out
            </button>
          )}
        </div>
      </aside>
      <main className="main" onClick={() => open && setOpen(false)}>
        {isPrototype && <div className="proto-banner">Prototype: everything here runs on simulated data in your browser. Try approving Scout's pull request, or message Ada while she works.</div>}
        <Outlet />
      </main>
    </div>
  );
}

function NotFound() {
  return (
    <div className="page">
      <h1>Page not found</h1>
      <p className="muted">
        The link may be out of date. <NavLink to="/">Go to the fleet</NavLink>.
      </p>
    </div>
  );
}

const routes = [
  {
    path: "/",
    element: <Shell />,
    children: [
      { index: true, element: <FleetPage /> },
      { path: "approvals", element: <ApprovalsPage /> },
      { path: "memory", element: <MemoryPage /> },
      { path: "knowledge", element: <KnowledgePage /> },
      { path: "routines", element: <RoutinesPage /> },
      { path: "platform", element: <PlatformPage /> },
      { path: "bots/new", element: <BotSettingsPage /> },
      { path: "bots/:botId", element: <BotWorkspace /> },
      { path: "bots/:botId/t/:threadId", element: <BotWorkspace /> },
      { path: "bots/:botId/settings", element: <BotSettingsPage /> },
      { path: "*", element: <NotFound /> },
    ],
  },
];
const router = isPrototype ? createHashRouter(routes) : createBrowserRouter(routes);

function Login({ error, onToken }: { error: string | null; onToken: (t: string) => void }) {
  const [token, setToken] = useState("");
  return (
    <div className="login">
      <div className="panel">
        <div className="panel-head">
          <div className="row">
            <OrreryMark />
            <h1 style={{ fontSize: "var(--t-lg)" }}>Sign in to Orrery</h1>
          </div>
        </div>
        <div className="panel-body stack">
          {error && <div className="error-box small">{error}</div>}
          {auth.configured ? (
            <button className="btn primary" onClick={() => void auth.login()}>
              Continue with single sign-on
            </button>
          ) : (
            <form className="stack" onSubmit={(e) => (e.preventDefault(), onToken(token.trim()))}>
              <p className="small muted" style={{ margin: 0 }}>
                No identity provider is configured for this deployment. Paste a development token (the API's <code>DEV_AUTH_TOKEN</code>) to continue.
              </p>
              <input className="input mono" type="password" value={token} onChange={(e) => setToken(e.target.value)} aria-label="Development token" autoFocus />
              <button className="btn primary" disabled={!token.trim()}>
                Sign in
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
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
        setError(status === 403 ? "Your account doesn't have access to a team." : null);
      } else setError(`Can't reach the Orrery API${config.apiUrl ? ` at ${config.apiUrl}` : ""}: ${(e as Error).message}`);
    }
  }, []);

  useEffect(() => {
    onUnauthorized(() => setNeedLogin(true));
    void boot();
  }, [boot]);

  if (needLogin) return <Login error={error} onToken={(t) => (auth.useDeveloperToken(t), setError(null), void boot())} />;
  if (error && !me)
    return (
      <div className="login">
        <div className="error-box">{error}</div>
      </div>
    );
  if (!api || !me) return <div className="login muted">Loading…</div>;
  return (
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
  );
}
