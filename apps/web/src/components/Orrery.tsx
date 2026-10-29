import { useNavigate } from "react-router";
import type { Bot } from "../api";
import type { BotActivity } from "./ui";

const RINGS: Array<{ key: Exclude<BotActivity, "paused">; r: number; label: string }> = [
  { key: "working", r: 72, label: "Working" },
  { key: "waiting", r: 124, label: "Waiting on you" },
  { key: "idle", r: 176, label: "Idle" },
];

/**
 * The fleet as an orrery: each teammate is a body on the ring for its current state —
 * inner ring working, middle ring waiting on a human, outer ring idle; paused bots are
 * parked below the instrument. Only the working ring turns.
 */
export function Orrery({ bots, activity }: { bots: Bot[]; activity: Record<string, BotActivity> }) {
  const nav = useNavigate();
  const byRing = (k: BotActivity) => bots.filter((b) => (activity[b.id] ?? "idle") === k);
  const parked = byRing("paused");
  const body = (b: Bot, x: number, y: number, k: BotActivity, rotate: boolean) => {
    const label = `${b.name}: ${{ working: "working", waiting: "waiting on you", idle: "idle", paused: "paused" }[k]}`;
    const go = () => nav(`/bots/${b.id}`);
    return (
      <g
        key={b.id}
        className={`body ${k} ${k === "paused" ? "parked" : ""}`}
        tabIndex={0}
        role="link"
        aria-label={label}
        onClick={go}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), go())}
      >
        <g className={rotate ? "counter" : undefined} style={rotate ? { transformOrigin: `${x}px ${y}px` } : undefined}>
          <title>{label}</title>
          <circle className="planet" cx={x} cy={y} r={15} />
          <text className="initial" x={x} y={y + 4} textAnchor="middle">
            {(b.avatar || b.name[0] || "?").slice(0, 1)}
          </text>
          <text x={x} y={y + 32} textAnchor="middle">
            {b.name}
          </text>
        </g>
      </g>
    );
  };
  return (
    <figure className="orrery" style={{ margin: 0 }}>
      <svg viewBox="-215 -215 430 500" role="img" aria-label="Fleet status">
        {RINGS.map((ring) => (
          <g key={ring.key}>
            <circle className={`ring ${ring.key}`} r={ring.r} />
            <text className="ring-label" x={0} y={-ring.r - 6} textAnchor="middle">
              {ring.label}
            </text>
          </g>
        ))}
        <circle className="sun" r={22} />
        <circle r={4} fill="var(--ink)" />
        {RINGS.map((ring, ri) => {
          const members = byRing(ring.key);
          const nodes = members.map((b, i) => {
            const a = (Math.PI * 2 * i) / Math.max(members.length, 1) + 0.6 + ri * 1.1;
            return body(b, Math.round(Math.cos(a) * ring.r), Math.round(Math.sin(a) * ring.r), ring.key, ring.key === "working");
          });
          return ring.key === "working" ? (
            <g key={ring.key} className="orbit-working">
              {nodes}
            </g>
          ) : (
            <g key={ring.key}>{nodes}</g>
          );
        })}
        {parked.length > 0 && (
          <g>
            <line x1={-190} x2={190} y1={225} y2={225} stroke="var(--hair)" strokeDasharray="3 4" />
            <text className="ring-label" x={-190} y={244}>
              Paused
            </text>
            {parked.map((b, i) => body(b, -120 + i * 70, 255, "paused", false))}
          </g>
        )}
      </svg>
      <figcaption className="legend">
        <span>
          <i className="dot working" /> Working
        </span>
        <span>
          <i className="dot waiting" /> Waiting on you
        </span>
        <span>
          <i className="dot idle" /> Idle
        </span>
        <span>
          <i className="dot idle paused" /> Paused
        </span>
      </figcaption>
    </figure>
  );
}
