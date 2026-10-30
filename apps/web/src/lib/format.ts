const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function relTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const s = (Date.parse(iso) - Date.now()) / 1000;
  const a = Math.abs(s);
  if (a < 45) return "just now";
  if (a < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (a < 86400) return rtf.format(Math.round(s / 3600), "hour");
  if (a < 86400 * 30) return rtf.format(Math.round(s / 86400), "day");
  return new Date(iso).toLocaleDateString();
}

export const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
export const num = (n: number | undefined) => (n === undefined ? "–" : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString());
export const pct = (n: number | undefined) => (n === undefined ? "–" : `${Math.round(n * 100)}%`);
export const duration = (ms: number | undefined) => (ms === undefined ? "–" : ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);

export function engineLabel(primary: { kind: string; engine?: string; providerId?: string; model?: string; modelId?: string; command?: string }): string {
  if (primary.kind === "kiro-acp") return primary.engine === "v2" ? "Kiro CLI v2" : primary.engine === "auto" ? "Kiro CLI (auto)" : "Kiro CLI V3";
  if (primary.kind === "opencode-acp") return "OpenCode";
  if (primary.kind === "openai") return `${primary.providerId} / ${primary.model}`;
  return `ACP: ${primary.command}`;
}

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Human-readable schedule for the common cron shapes; falls back to the expression. */
export function describeSchedule(s: { cron?: string; intervalMinutes?: number; timezone: string }): string {
  if (s.intervalMinutes) return s.intervalMinutes % 60 === 0 ? `Every ${s.intervalMinutes / 60 === 1 ? "hour" : `${s.intervalMinutes / 60} hours`}` : `Every ${s.intervalMinutes} minutes`;
  const parts = (s.cron ?? "").trim().split(/\s+/);
  if (parts.length !== 5) return s.cron ?? "";
  const [m, h, dom, mon, dow] = parts as [string, string, string, string, string];
  if (!/^\d+$/.test(m) || !/^\d+$/.test(h) || dom !== "*" || mon !== "*") return `${s.cron} (${s.timezone})`;
  const time = `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
  const tz = s.timezone === "UTC" ? "UTC" : s.timezone.split("/").pop()!.replace(/_/g, " ");
  if (dow === "*") return `Daily at ${time} ${tz} time`;
  if (dow === "1-5") return `Weekdays at ${time} ${tz} time`;
  if (/^\d$/.test(dow)) return `${DOW[Number(dow)]}s at ${time} ${tz} time`;
  return `${s.cron} (${s.timezone})`;
}
