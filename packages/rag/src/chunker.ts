/**
 * Structure-aware chunking: split on Markdown headings first (keeping the heading path as
 * context), then paragraphs, then sentences, packing pieces up to `size` characters with
 * `overlap` characters carried between neighbouring chunks of the same section.
 */
export interface Chunk {
  ord: number;
  heading: string | null;
  content: string;
}

interface Section {
  path: string[];
  body: string;
}

function sections(text: string): Section[] {
  const out: Section[] = [];
  const path: string[] = [];
  let body: string[] = [];
  let inFence = false;
  const flush = () => {
    const b = body.join("\n").trim();
    if (b) out.push({ path: [...path], body: b });
    body = [];
  };
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence ? /^(#{1,6})\s+(.*\S)\s*$/.exec(line) : null;
    if (m) {
      flush();
      const level = m[1]!.length;
      path.splice(level - 1);
      path[level - 1] = m[2]!;
      for (let i = 0; i < level - 1; i++) path[i] ??= "";
      continue;
    }
    body.push(line);
  }
  flush();
  return out;
}

function splitParagraphs(body: string): string[] {
  // keep fenced code blocks intact
  const parts: string[] = [];
  let buf: string[] = [];
  let inFence = false;
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && line.trim() === "") {
      if (buf.length) parts.push(buf.join("\n"));
      buf = [];
    } else buf.push(line);
  }
  if (buf.length) parts.push(buf.join("\n"));
  return parts;
}

function splitSentences(p: string, size: number): string[] {
  if (p.length <= size) return [p];
  const sentences = p.match(/[^.!?\n]+[.!?]+["')\]]*\s*|[^.!?\n]+$|\n/g) ?? [p];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if ((cur + s).length > size && cur) {
      out.push(cur.trim());
      cur = "";
    }
    if (s.length > size) {
      for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
      continue;
    }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function chunkText(text: string, size = 1200, overlap = 150): Chunk[] {
  if (size < 100) throw new Error("chunk size too small");
  const chunks: Chunk[] = [];
  let ord = 0;
  for (const sec of sections(text)) {
    const heading = sec.path.filter(Boolean).join(" › ") || null;
    const pieces = splitParagraphs(sec.body).flatMap((p) => splitSentences(p, size));
    let cur = "";
    let tail = "";
    const emit = () => {
      const content = cur.trim();
      if (content) chunks.push({ ord: ord++, heading, content });
      tail = overlap > 0 ? content.slice(-overlap) : "";
      cur = tail ? tail.replace(/^\S*\s/, "") + "\n" : "";
    };
    for (const piece of pieces) {
      if (cur.length + piece.length + 2 > size && cur.trim().length > (tail.length || 0)) emit();
      cur += (cur && !cur.endsWith("\n") ? "\n\n" : "") + piece;
    }
    if (cur.trim().length > (tail ? tail.length : 0)) emit();
  }
  return chunks;
}
