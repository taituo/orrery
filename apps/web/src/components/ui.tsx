import { useEffect, useRef, type ReactNode } from "react";
import type { Bot } from "../api";
import { Orb } from "./Orb";

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p className="small">{children}</p>}
      {action && <div style={{ marginTop: 12 }}>{action}</div>}
    </div>
  );
}

export function ErrorBox({ error }: { error: Error | null | undefined }) {
  if (!error) return null;
  return (
    <div className="error-box" role="alert">
      {error.message}
    </div>
  );
}

export function Meter({ value, label }: { value: number | undefined; label?: string }) {
  const v = Math.max(0, Math.min(100, value ?? 0));
  return (
    <div className={`meter ${v > 85 ? "bad" : v > 65 ? "warn" : ""}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v)} aria-label={label ?? "usage"}>
      <i style={{ width: `${v}%` }} />
    </div>
  );
}

export type BotActivity = "working" | "waiting" | "idle" | "paused";

export function Avatar({ bot, activity, size }: { bot: Pick<Bot, "name" | "avatar"> & { id?: string }; activity?: BotActivity; size?: "sm" | "lg" | "xl" }) {
  return <Orb id={bot.id ?? bot.name} name={bot.name} avatar={bot.avatar ?? null} activity={activity} {...(size ? { size } : {})} />;
}

export function StatusDot({ activity }: { activity: BotActivity }) {
  const label = { working: "Working", waiting: "Waiting on you", idle: "Idle", paused: "Paused" }[activity];
  return <span className={`dot ${activity}`} role="img" aria-label={label} title={label} />;
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ value, tabs, onChange }: { value: T; tabs: Array<{ value: T; label: ReactNode }>; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={value === t.value} onClick={() => onChange(t.value)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Dialog({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="dialog" onClose={onClose} aria-label={title}>
      {open && children}
    </dialog>
  );
}

/** Line glyphs for tool kinds — drawn, not emoji, so they read like the rest of the wireframe. */
export function KindIcon({ kind }: { kind: string }) {
  const p = { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (kind) {
    case "execute":
      return (
        <svg {...p}>
          <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
          <path d="M4 6l2 2-2 2M8 10h4" />
        </svg>
      );
    case "read":
      return (
        <svg {...p}>
          <path d="M4 1.5h5l3 3v10H4z" />
          <path d="M9 1.5v3h3M6 8h4M6 10.5h4" />
        </svg>
      );
    case "edit":
      return (
        <svg {...p}>
          <path d="M10.5 2.5l3 3-8 8H2.5v-3z" />
        </svg>
      );
    case "delete":
      return (
        <svg {...p}>
          <path d="M3 4.5h10M6 4.5V2.5h4v2M4.5 4.5l.7 9h5.6l.7-9" />
        </svg>
      );
    case "search":
      return (
        <svg {...p}>
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5l3.5 3.5" />
        </svg>
      );
    case "fetch":
      return (
        <svg {...p}>
          <circle cx="8" cy="8" r="6.5" />
          <path d="M1.5 8h13M8 1.5c2 2 2 11 0 13M8 1.5c-2 2-2 11 0 13" />
        </svg>
      );
    case "move":
      return (
        <svg {...p}>
          <path d="M2 8h11M10 5l3 3-3 3" />
        </svg>
      );
    case "think":
      return (
        <svg {...p}>
          <path d="M5 13.5h6M6 11.5h4M8 1.5a4.5 4.5 0 00-2.5 8.2v1.8h5V9.7A4.5 4.5 0 008 1.5z" />
        </svg>
      );
    default:
      return (
        <svg {...p}>
          <circle cx="8" cy="8" r="2" />
          <path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3" />
        </svg>
      );
  }
}

export function OrreryMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <circle cx="16" cy="16" r="12.5" stroke="currentColor" strokeWidth="1.2" opacity="0.55" />
      <circle cx="16" cy="16" r="4.2" fill="currentColor" />
      <circle cx="26.8" cy="10.6" r="2.6" fill="currentColor" />
    </svg>
  );
}
