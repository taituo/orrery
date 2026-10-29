import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Message, OrreryApi, Principal, Run, RunEventEnvelope, TeamNotice } from "../api";
import { applyEvent, emptyRun, isActive, type RunView } from "./runs";

interface Ctx {
  api: OrreryApi;
  me: Principal;
  /** Bumped on team-wide notices so lists (approvals, fleet) refresh. */
  pulse: number;
  toast: (text: string, tone?: "info" | "error") => void;
}

const ApiContext = createContext<Ctx | null>(null);

export function ApiProvider({ api, me, children, toast }: { api: OrreryApi; me: Principal; children: ReactNode; toast: Ctx["toast"] }) {
  const [pulse, setPulse] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    // coalesce bursts of notices (token deltas) into at most ~1 refresh per second
    const unsub = api.streamTeam((n: TeamNotice) => {
      if (n.kind === "approval") setPulse((p) => p + 1);
      else if (!timer)
        timer = setTimeout(() => {
          timer = null;
          setPulse((p) => p + 1);
        }, 1000);
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [api]);
  const value = useMemo(() => ({ api, me, pulse, toast }), [api, me, pulse, toast]);
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

export function useApi(): Ctx {
  const c = useContext(ApiContext);
  if (!c) throw new Error("ApiProvider missing");
  return c;
}

export function useCan(min: Principal["role"]): boolean {
  const { me } = useApi();
  const rank = { viewer: 0, member: 1, admin: 2, owner: 3 } as const;
  return rank[me.role] >= rank[min];
}

/**
 * Load data; reloads when deps change or `reload()` is called. Previous data is kept while
 * refreshing the same thing (e.g. on a team notice), but dropped when `key` changes so a view
 * never shows another entity's data.
 */
export function useLoad<T>(fn: (api: OrreryApi) => Promise<T>, deps: unknown[], key?: string): { data: T | undefined; error: Error | null; loading: boolean; reload: () => void } {
  const { api } = useApi();
  const [state, setState] = useState<{ data: T | undefined; error: Error | null; loading: boolean; key?: string }>({ data: undefined, error: null, loading: true, ...(key !== undefined ? { key } : {}) });
  const [n, setN] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let alive = true;
    setState((s) => (s.key !== key ? { data: undefined, error: null, loading: true, ...(key !== undefined ? { key } : {}) } : { ...s, loading: true }));
    fnRef.current(api).then(
      (data) => alive && setState({ data, error: null, loading: false, ...(key !== undefined ? { key } : {}) }),
      (error: Error) => alive && setState((s) => ({ ...s, error, loading: false })),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, n, key, ...deps]);
  const reload = useCallback(() => setN((x) => x + 1), []);
  const stale = state.key !== key;
  return { data: stale ? undefined : state.data, error: stale ? null : state.error, loading: stale || state.loading, reload };
}

/** Live view of a thread: messages + per-run folded event streams. */
export function useThread(threadId: string | undefined) {
  const { api } = useApi();
  const [messages, setMessages] = useState<Message[]>([]);
  const [runs, setRuns] = useState<Record<string, RunView>>({});
  const [runMeta, setRunMeta] = useState<Record<string, Run>>({});
  const [stream, setStream] = useState<"connecting" | "open" | "retrying">("connecting");
  const seen = useRef(new Set<string>());

  const loadMessages = useCallback(async () => {
    if (!threadId) return;
    const [m, r] = await Promise.all([api.listMessages(threadId), api.listRuns(threadId)]);
    setMessages(m);
    setRunMeta(Object.fromEntries(r.map((x) => [x.id, x])));
  }, [api, threadId]);

  useEffect(() => {
    if (!threadId) return;
    seen.current = new Set();
    setRuns({});
    setMessages([]);
    void loadMessages();
    let pending: RunEventEnvelope[] = [];
    let frame = 0;
    const flush = () => {
      frame = 0;
      const batch = pending;
      pending = [];
      let terminal = false;
      setRuns((prev) => {
        const next = { ...prev };
        for (const env of batch) next[env.runId] = applyEvent(next[env.runId] ?? emptyRun(env), env);
        return next;
      });
      for (const env of batch) if (env.event.type === "turn.completed" || env.event.type === "turn.failed" || env.event.type === "turn.interrupted") terminal = true;
      if (terminal) setTimeout(() => void loadMessages(), 150);
    };
    const unsub = api.streamThread(
      threadId,
      (env) => {
        const key = `${env.runId}:${env.seq}`;
        if (seen.current.has(key)) return;
        seen.current.add(key);
        pending.push(env);
        // batch token deltas into one render per animation frame
        if (!frame) frame = requestAnimationFrame(flush);
      },
      setStream,
    );
    return () => {
      unsub();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [api, threadId, loadMessages]);

  const runList = useMemo(() => Object.values(runs).sort((a, b) => a.startedAt.localeCompare(b.startedAt)), [runs]);
  const active = runList.find(isActive) ?? null;
  return { messages, runs: runList, runMeta, active, stream, reloadMessages: loadMessages };
}

export function usePrefersReducedMotion(): boolean {
  const [v, setV] = useState(() => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const m = matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setV(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return v;
}
