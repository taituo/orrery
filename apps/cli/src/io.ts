import type { Readable, Writable } from "node:stream";

export interface Io {
  stdin: Readable;
  stdout: Writable;
  isTTY: boolean;
  out(line: string): void;
  err(line: string): void;
  write(s: string): void;
  env: Record<string, string | undefined>;
}

export function processIo(): Io {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    isTTY: Boolean(process.stdout.isTTY && process.stdin.isTTY),
    out: (l) => void process.stdout.write(`${l}\n`),
    err: (l) => void process.stderr.write(`${l}\n`),
    write: (s) => void process.stdout.write(s),
    env: process.env,
  };
}

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (open: string, close: string) => (s: string) => (color ? `\u001b[${open}m${s}\u001b[${close}m` : s);

export const style = {
  bold: wrap("1", "22"),
  dim: wrap("2", "22"),
  red: wrap("31", "39"),
  green: wrap("32", "39"),
  yellow: wrap("33", "39"),
  accent: wrap("38;5;209", "39"),
};

/** Simple aligned table. */
export function table(rows: string[][], headers?: string[]): string {
  const all = headers ? [headers, ...rows] : rows;
  const widths = all.reduce<number[]>((w, r) => r.map((c, i) => Math.max(w[i] ?? 0, visible(c).length)), []);
  const fmt = (r: string[]) => r.map((c, i) => (i === r.length - 1 ? c : c + " ".repeat(widths[i]! - visible(c).length))).join("  ");
  return [...(headers ? [style.dim(fmt(headers))] : []), ...rows.map(fmt)].join("\n");
}

// eslint-disable-next-line no-control-regex
const visible = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
