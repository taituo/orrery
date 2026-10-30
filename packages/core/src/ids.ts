import { randomBytes } from "node:crypto";

/**
 * Time-sortable identifiers (ULID layout: 48-bit ms timestamp + 80 bits of randomness,
 * Crockford base32). Prefixed for readability in logs and URLs: `bot_01J...`, `run_01J...`.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(ms: number, len: number): string {
  let out = "";
  let value = ms;
  for (let i = len - 1; i >= 0; i--) {
    const mod = value % 32;
    out = ALPHABET[mod] + out;
    value = (value - mod) / 32;
  }
  return out;
}

function encodeRandom(len: number): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i]! % 32];
  return out;
}

export function ulid(now: number = Date.now()): string {
  return encodeTime(now, 10) + encodeRandom(16);
}

export const ID_PREFIXES = {
  team: "team",
  user: "usr",
  bot: "bot",
  thread: "thr",
  message: "msg",
  run: "run",
  approval: "apr",
  memory: "mem",
  episode: "epi",
  knowledgeBase: "kb",
  source: "src",
  chunk: "chk",
  routine: "rtn",
  event: "evt",
  computer: "cmp",
  audit: "aud",
  delegation: "dlg",
  apiToken: "tok",
  room: "room",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${ulid()}`;
}

export function isId(kind: IdKind, value: unknown): value is string {
  return typeof value === "string" && value.startsWith(`${ID_PREFIXES[kind]}_`) && value.length === ID_PREFIXES[kind].length + 27;
}
