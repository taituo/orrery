import { useEffect, useState } from "react";

/** auto follows the system: "her" by day, "dusk" when the system is dark. */
export type Theme = "auto" | "her" | "dusk" | "eclipse" | "synapse" | "nebula" | "wire";
export const THEMES: readonly Theme[] = ["auto", "her", "dusk", "eclipse", "synapse", "nebula", "wire"];
export type ResolvedTheme = Exclude<Theme, "auto">;

const KEY = "orrery.theme";

export function readTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return THEMES.includes(t as Theme) ? (t as Theme) : "auto";
  } catch {
    return "auto";
  }
}

export function applyTheme(t: Theme): void {
  if (t === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* a per-viewer convenience only */
  }
  window.dispatchEvent(new CustomEvent("orrery-theme", { detail: t }));
}

const systemDark = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches;

export function resolve(t: Theme): ResolvedTheme {
  return t === "auto" ? (systemDark() ? "dusk" : "her") : t;
}

/** The theme in effect, following changes from the settings page and the system. */
export function useTheme(): [Theme, ResolvedTheme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [, force] = useState(0);
  useEffect(() => {
    const onTheme = (e: Event) => setTheme((e as CustomEvent<Theme>).detail);
    const m = matchMedia("(prefers-color-scheme: dark)");
    const onSystem = () => force((x) => x + 1);
    window.addEventListener("orrery-theme", onTheme);
    m.addEventListener("change", onSystem);
    return () => {
      window.removeEventListener("orrery-theme", onTheme);
      m.removeEventListener("change", onSystem);
    };
  }, []);
  return [theme, resolve(theme), applyTheme];
}
