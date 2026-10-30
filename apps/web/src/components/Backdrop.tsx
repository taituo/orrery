import { useEffect, useState } from "react";
import { MeshGradient } from "@paper-design/shaders-react";
import { usePrefersReducedMotion } from "../lib/hooks";
import type { ResolvedTheme } from "../lib/theme";

/**
 * The room: a slow mesh gradient in Her's warm light (coral, tangerine, peach, blush), with a
 * film grain. Rendered at a low resolution (it is all soft gradients) to stay cheap under
 * frosted glass; still when motion is reduced or the tab is hidden. The wireframe theme has
 * no backdrop.
 */
const PALETTES: Record<Exclude<ResolvedTheme, "wire">, { colors: string[]; speed: number; grain: number }> = {
  her: { colors: ["#e8503b", "#f38463", "#f6a283", "#dd4330", "#f9b99c"], speed: 0.09, grain: 0.14 },
  dusk: { colors: ["#1d0f13", "#5a1f22", "#b8463a", "#2b1418", "#7a2c2a"], speed: 0.06, grain: 0.2 },
};

export function Backdrop({ theme }: { theme: ResolvedTheme }) {
  const reduced = usePrefersReducedMotion();
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden);
  useEffect(() => {
    const on = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  if (theme === "wire") return null;
  const p = PALETTES[theme];
  return (
    <div className="backdrop" aria-hidden>
      <MeshGradient colors={p.colors} distortion={0.85} swirl={0.28} speed={reduced || hidden ? 0 : p.speed} grainOverlay={p.grain} grainMixer={0.06} maxPixelCount={900 * 600} minPixelRatio={1} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}
