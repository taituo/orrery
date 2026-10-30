import { useEffect, useState, type CSSProperties } from "react";
import { GemSmoke, MeshGradient, NeuroNoise, SmokeRing } from "@paper-design/shaders-react";
import { usePrefersReducedMotion } from "../lib/hooks";
import { mix, useEased, useFlare, useMood } from "../lib/mood";
import type { ResolvedTheme } from "../lib/theme";

/**
 * The room every panel floats in. Each look is one live shader (paper-design/shaders) that
 * answers what the bots are doing:
 *
 * - energy: bots working → the room moves faster and brightens;
 * - alert: someone is waiting for you → the room warms toward coral and a slow glow breathes;
 * - flare: you just sent something → a brief surge, then it settles.
 *
 * Still when motion is reduced or the tab is hidden. The wireframe look has no room at all.
 */
export function Backdrop({ theme }: { theme: ResolvedTheme }) {
  const reduced = usePrefersReducedMotion();
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden);
  useEffect(() => {
    const on = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  // With the rail on the left, the visual centre of the room sits right of the window's centre.
  const [wide, setWide] = useState(() => typeof matchMedia === "undefined" || matchMedia("(min-width: 761px)").matches);
  useEffect(() => {
    const m = matchMedia("(min-width: 761px)");
    const on = () => setWide(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  const mood = useMood();
  const energy = useEased(Math.min(1, mood.working * 0.45));
  const alert = useEased(mood.waiting > 0 ? 1 : 0, 2400);
  const flare = useFlare(mood.flareAt);
  if (theme === "wire") return null;

  const still = reduced || hidden;
  const speed = (base: number, e: number, f: number) => (still ? 0 : base + e * energy + f * flare);
  const canvas: CSSProperties = { width: "100%", height: "100%" };
  const room = (() => {
    switch (theme) {
      case "her":
        return <MeshGradient colors={["#e8503b", "#f38463", "#f6a283", "#dd4330", "#f9b99c"]} distortion={0.85 + 0.1 * flare} swirl={0.28 + 0.12 * energy} speed={speed(0.09, 0.2, 0.6)} grainOverlay={0.14} grainMixer={0.06} maxPixelCount={900 * 600} minPixelRatio={1} style={canvas} />;
      case "dusk":
        return <MeshGradient colors={["#1d0f13", "#5a1f22", mix("#b8463a", "#e0563f", alert), "#2b1418", "#7a2c2a"]} distortion={0.85} swirl={0.28 + 0.12 * energy} speed={speed(0.06, 0.16, 0.5)} grainOverlay={0.2} grainMixer={0.06} maxPixelCount={900 * 600} minPixelRatio={1} style={canvas} />;
      case "eclipse":
        // A ring of fire around a dark disc: the orrery's sun, eclipsed.
        return (
          <SmokeRing
            colorBack="#05030a"
            colors={["#fff6ee", mix("#ffb27a", "#ffc58f", flare), mix("#ff5a3c", "#ff3d55", alert), mix("#8a1f5a", "#c42a52", alert)]}
            noiseScale={1.6 + 0.8 * energy}
            noiseIterations={5}
            radius={0.3}
            thickness={0.17 + 0.06 * energy + 0.12 * flare}
            innerShape={0.9}
            scale={1}
            offsetX={wide ? 0.12 : 0}
            offsetY={0.1}
            speed={speed(0.32, 0.8, 1.8)}
            maxPixelCount={1400 * 900}
            minPixelRatio={1}
            style={canvas}
          />
        );
      case "synapse":
        // A living nervous system: filaments fire faster and brighter while bots think.
        return (
          <NeuroNoise
            colorFront="#f2fbff"
            colorMid={mix("#7b4dff", "#ff5a7a", alert * 0.75)}
            colorBack="#04030c"
            brightness={0.045 + 0.05 * energy + 0.12 * flare}
            contrast={0.32}
            scale={1.1}
            speed={speed(0.2, 0.9, 1.6)}
            maxPixelCount={1400 * 900}
            minPixelRatio={1}
            style={canvas}
          />
        );
      case "nebula":
        // A glass planet stirring a nebula of indigo and coral around itself.
        return (
          <GemSmoke
            colorBack="#04050d"
            colorInner="#0a0a1a"
            colors={["#3d5cff", "#8a5cff", mix("#ff7a59", "#ff4d6d", alert), "#ffe6d6"]}
            outerGlow={0.85 + 0.15 * flare}
            innerGlow={1}
            innerDistortion={1}
            outerDistortion={1}
            offset={0.1}
            angle={20}
            size={0.6}
            scale={0.85}
            offsetX={wide ? 0.3 : 0.18}
            offsetY={0.04}
            shape="circle"
            speed={speed(0.2, 0.7, 1.5)}
            maxPixelCount={1200 * 760}
            minPixelRatio={1}
            style={canvas}
          />
        );
    }
  })();
  return (
    <div className={`backdrop ${theme}`} aria-hidden>
      {room}
      {(theme === "eclipse" || theme === "nebula") && <div className="stars" />}
      <div className="backdrop-alert" style={{ opacity: alert }} />
    </div>
  );
}
