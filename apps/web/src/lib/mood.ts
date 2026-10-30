import { useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * The room's mood: how many bots are working, whether someone is waiting on you, and the last
 * time you sent something. The shell publishes it; the backdrop shader reacts to it. A tiny
 * store of its own because the backdrop lives outside the API provider (it also runs on the
 * sign-in screen).
 */
export interface Mood {
  working: number;
  waiting: number;
  flareAt: number;
}

let current: Mood = { working: 0, waiting: 0, flareAt: 0 };
const subscribers = new Set<() => void>();
const publish = (next: Mood) => {
  current = next;
  for (const f of subscribers) f();
};

export function setActivity(working: number, waiting: number): void {
  if (working !== current.working || waiting !== current.waiting) publish({ ...current, working, waiting });
}

/** Something just happened that the room should answer (a message sent, an approval given). */
export function flare(): void {
  publish({ ...current, flareAt: Date.now() });
}

export function useMood(): Mood {
  return useSyncExternalStore(
    (f) => (subscribers.add(f), () => void subscribers.delete(f)),
    () => current,
    () => current,
  );
}

/**
 * A number that glides toward `target` instead of jumping (critically damped), so shader
 * parameters change like light does. Renders at most ~24 times a second, and not at all once
 * it has arrived.
 */
export function useEased(target: number, ms = 1600): number {
  const [value, setValue] = useState(target);
  const now = useRef(target);
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let shown = 0;
    const tick = (t: number) => {
      const k = 1 - Math.exp(-(t - last) / (ms / 4));
      last = t;
      now.current += (target - now.current) * k;
      const done = Math.abs(target - now.current) < 0.002;
      if (done) now.current = target;
      if (done || t - shown > 42) {
        shown = t;
        setValue(now.current);
      }
      if (!done) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return value;
}

/** 1 right after a flare, easing back to 0. */
export function useFlare(flareAt: number): number {
  const [hot, setHot] = useState(false);
  useEffect(() => {
    if (!flareAt) return;
    setHot(true);
    const t = setTimeout(() => setHot(false), 260);
    return () => clearTimeout(t);
  }, [flareAt]);
  return useEased(hot ? 1 : 0, hot ? 500 : 2600);
}

/** Mix two #rrggbb colors. */
export function mix(a: string, b: string, t: number): string {
  const p = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  const c = [0, 1, 2].map((i) => Math.round(p(a, i) + (p(b, i) - p(a, i)) * Math.min(1, Math.max(0, t))));
  return `#${c.map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}
