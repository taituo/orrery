/**
 * Pure ranking utilities shared by memory recall and RAG search.
 */

/** Reciprocal Rank Fusion over several ranked id lists. */
export function rrf(lists: string[][], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1)));
  }
  return scores;
}

/** Exponential recency decay: 1.0 now, 0.5 after `halfLifeDays`. */
export function recency(isoDate: string | null, halfLifeDays = 30, now = Date.now()): number {
  if (!isoDate) return 0.5;
  const ageDays = Math.max(0, (now - Date.parse(isoDate)) / 86_400_000);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

export interface Rankable {
  id: string;
  importance: number;
  pinned: boolean;
  lastAccessedAt: string | null;
  createdAt: string;
}

/**
 * Final memory score: relevance (RRF, normalized) dominates; importance and recency break ties
 * and lift durable facts; pinned memories always surface when relevant at all.
 */
export function scoreMemory(item: Rankable, fused: number, maxFused: number, now = Date.now()): number {
  const relevance = maxFused > 0 ? fused / maxFused : 0;
  const rec = item.pinned ? 1 : recency(item.lastAccessedAt ?? item.createdAt, 45, now);
  return 0.62 * relevance + 0.23 * item.importance + 0.1 * rec + (item.pinned ? 0.15 : 0);
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Obvious credentials are never stored as memories, whatever the decision model says. */
const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk|ksk|ghp|gho|ghs|glpat|xox[abpr])[-_][A-Za-z0-9_-]{16,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S{6,}/i,
  // "the prod password is hunter2-…": the value must look like a credential (has a digit/symbol)
  /\b(?:password|passwd|pwd|passphrase|secret|api[_ -]?key|access[_ -]?token|token|pin)\s+(?:is|was|=|:)\s+["'`]?(?=\S*[\d!@#$%^&*_+=-])\S{6,}/i,
  /\b\d{3}-\d{2}-\d{4}\b/, // US SSN
  /\b(?:\d[ -]*?){13,19}\b(?=.*(?:card|visa|mastercard|amex))/i,
];

export function looksSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}
