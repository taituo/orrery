import { OrreryError } from "@orrery/core";

/**
 * Turn source bytes into plain text. HTML is reduced to readable text (scripts, styles and
 * navigation chrome dropped), PDFs via unpdf, JSON pretty-printed, everything text-like as-is.
 */
export async function toText(content: Buffer, mimeType: string | null, uri: string): Promise<string> {
  const mime = (mimeType ?? guessMime(uri)).toLowerCase();
  if (mime.includes("pdf")) {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(content));
    const { text } = await extractText(pdf, { mergePages: true });
    return Array.isArray(text) ? text.join("\n\n") : text;
  }
  const raw = content.toString("utf8");
  if (mime.includes("html")) return htmlToText(raw);
  if (mime.includes("json")) {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }
  if (mime.startsWith("text/") || mime.includes("markdown") || mime.includes("yaml") || mime.includes("xml") || mime.includes("csv")) return raw;
  if (/[\x00-\x08\x0E-\x1F]/.test(raw.slice(0, 4096))) throw new OrreryError("bad_request", `unsupported binary content type ${mime}`);
  return raw;
}

export function guessMime(uri: string): string {
  const ext = uri.toLowerCase().split("?")[0]!.split(".").pop() ?? "";
  return (
    {
      md: "text/markdown",
      markdown: "text/markdown",
      txt: "text/plain",
      html: "text/html",
      htm: "text/html",
      json: "application/json",
      pdf: "application/pdf",
      csv: "text/csv",
      yaml: "application/yaml",
      yml: "application/yaml",
      xml: "application/xml",
      ts: "text/plain",
      js: "text/plain",
      py: "text/plain",
      go: "text/plain",
      rs: "text/plain",
    } as Record<string, string>
  )[ext] ?? "text/plain";
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, l: string, t: string) => `\n\n${"#".repeat(Number(l))} ${t.replace(/<[^>]+>/g, "").trim()}\n\n`)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/ul|\/ol|\/table|\/section|\/article)\b[^>]*>/gi, "\n")
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, t: string) => `\n\`\`\`\n${t}\n\`\`\`\n`)
    .replace(/<[^>]+>/g, " ");
  s = s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
  return s
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Fetch a URL source with size and type limits (runs in the memory worker, egress-controlled). */
export async function fetchUrl(url: string, opts: { maxBytes?: number; timeoutMs?: number } = {}): Promise<{ content: Buffer; mimeType: string | null }> {
  const u = new URL(url);
  if (!["http:", "https:"].includes(u.protocol)) throw new OrreryError("bad_request", "only http(s) URLs can be ingested");
  const res = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000), redirect: "follow", headers: { "user-agent": "OrreryKnowledgeBot/1.0" } });
  if (!res.ok) throw new OrreryError("provider_error", `fetch ${url} failed: HTTP ${res.status}`);
  const max = opts.maxBytes ?? 25 * 1024 * 1024;
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > max) throw new OrreryError("bad_request", `source too large (${len} bytes)`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > max) throw new OrreryError("bad_request", `source too large (${buf.length} bytes)`);
  return { content: buf, mimeType: res.headers.get("content-type") };
}
