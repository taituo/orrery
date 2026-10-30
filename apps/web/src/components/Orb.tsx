import type { CSSProperties } from "react";
import type { BotActivity } from "./ui";

/** Each bot gets its own warm light, derived from its id, so it is recognisable everywhere. */
const LIGHTS: Array<[string, string, string]> = [
  ["#f58a5b", "#ee5a46", "#fde0cf"],
  ["#f7a07f", "#d9475f", "#ffe1e4"],
  ["#f6b26b", "#e2683c", "#fff0d6"],
  ["#e98aa0", "#b8476a", "#fde2ea"],
  ["#f29d7a", "#c9533b", "#ffe6d8"],
  ["#d99b8a", "#9e4b3f", "#f7e1d9"],
  ["#f3b4a3", "#e06a55", "#fff1ec"],
  ["#c98f74", "#8d4a3a", "#f3ddd2"],
];

export function lightFor(id: string): [string, string, string] {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return LIGHTS[h % LIGHTS.length]!;
}

export function Orb({ id, name, avatar, activity, size, title }: { id: string; name: string; avatar?: string | null; activity?: BotActivity | undefined; size?: "sm" | "lg" | "xl"; title?: string }) {
  const [a, b, c] = lightFor(id);
  const style = { "--hue-a": a, "--hue-b": b, "--hue-c": c } as CSSProperties;
  return (
    <span className={`orb ${size ?? ""} ${activity ?? ""}`} style={style} aria-hidden={title ? undefined : true} title={title}>
      {(avatar || name[0] || "?").slice(0, 2)}
    </span>
  );
}

export function OrbStack({ members, size }: { members: Array<{ botId: string; name: string; avatar?: string | null }>; size?: "sm" | "lg" }) {
  return (
    <span className="orb-stack" aria-hidden>
      {members.slice(0, 3).map((m) => (
        <Orb key={m.botId} id={m.botId} name={m.name} avatar={m.avatar ?? null} {...(size ? { size } : {})} />
      ))}
    </span>
  );
}

/** The OS1 line: a soft moving wave while a bot is working. */
export function Wave({ label }: { label?: string }) {
  const d = "M0 7 Q 5.75 1 11.5 7 T 23 7 T 34.5 7 T 46 7 T 57.5 7 T 69 7 T 80.5 7 T 92 7";
  return (
    <span className="wave" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <svg viewBox="0 0 92 14">
        <path d={d} />
      </svg>
    </span>
  );
}
