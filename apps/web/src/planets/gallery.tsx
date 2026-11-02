import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/jost";
import { PLANETS } from "./designs";
import { Planet } from "./Planet";

/** Design reference: the twenty bot planets, in each state. Built with `vite build --mode planets`. */
const css = `
:root { --bg: #0b0810; --ink: #f4eef0; --ink-2: #a99fa8; --card: rgba(255,255,255,0.04); --accent: #ff7a59; color-scheme: dark; }
:root[data-bg="light"] { --bg: #f6ece6; --ink: #2d1d1b; --ink-2: #7b6460; --card: rgba(255,255,255,0.55); color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font-family: "Jost Variable", ui-sans-serif, system-ui, sans-serif; transition: background 0.4s; }
main { max-width: 1120px; margin: 0 auto; padding: 48px 16px 64px; }
h1 { font-weight: 250; font-size: clamp(36px, 6vw, 64px); margin: 0 0 6px; letter-spacing: -0.02em; }
p.lede { color: var(--ink-2); margin: 0 0 28px; max-width: 62ch; line-height: 1.5; }
.bar { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 28px; }
.bar button { font: inherit; border: 0; border-radius: 999px; padding: 8px 16px; background: var(--card); color: var(--ink); cursor: pointer; }
.bar button[aria-pressed="true"] { background: var(--accent); color: #1a0905; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 14px; }
.cell { background: var(--card); border-radius: 22px; padding: 18px 10px 14px; display: flex; flex-direction: column; align-items: center; gap: 10px; }
.cell .orb { position: relative; width: 96px; height: 96px; }
.cell .orb .planet { position: absolute; inset: -12.5%; width: 125%; height: 125%; }
.name { font-size: 15px; }
.num { font-size: 12px; color: var(--ink-2); }
.row { display: flex; gap: 20px; align-items: center; margin: 36px 0 12px; flex-wrap: wrap; }
.row .orb { position: relative; width: 34px; height: 34px; }
.row .orb .planet { position: absolute; inset: -12.5%; width: 125%; height: 125%; }
.row .label { color: var(--ink-2); font-size: 14px; }
`;

function Gallery() {
  const [state, setState] = useState<"idle" | "working" | "waiting">("idle");
  const [bg, setBg] = useState<"dark" | "light">("dark");
  document.documentElement.dataset.bg = bg;
  const energy = state === "working" ? 1 : 0;
  const alert = state === "waiting" ? 1 : 0;
  return (
    <main>
      <style>{css}</style>
      <h1>Planets</h1>
      <p className="lede">Twenty bot avatars from one procedural shader. Idle, they turn slowly. While a bot works it spins up and its atmosphere brightens; while it waits for you, a warm halo rises.</p>
      <div className="bar" role="group" aria-label="State">
        {(["idle", "working", "waiting"] as const).map((s) => (
          <button key={s} aria-pressed={state === s} onClick={() => setState(s)}>
            {s === "idle" ? "Idle" : s === "working" ? "Working" : "Waiting for you"}
          </button>
        ))}
        <button aria-pressed={bg === "light"} onClick={() => setBg(bg === "dark" ? "light" : "dark")}>
          Light background
        </button>
      </div>
      <div className="grid">
        {PLANETS.map((p, i) => (
          <div className="cell" key={p.name}>
            <span className="orb">
              <Planet design={i} size="xxl" energy={energy} alert={alert} />
            </span>
            <span className="name">{p.name}</span>
            <span className="num">planet:{i}</span>
          </div>
        ))}
      </div>
      <div className="row">
        <span className="label">At list size</span>
        {PLANETS.map((p, i) => (
          <span className="orb" key={p.name} title={p.name}>
            <Planet design={i} size="md" energy={energy} alert={alert} />
          </span>
        ))}
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
);
