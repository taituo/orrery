import { Fragment, type ReactNode } from "react";

/**
 * Small, safe Markdown renderer for agent output: paragraphs, headings, lists, fenced code,
 * inline code, bold, italic and links. Produces React elements only (never innerHTML), so
 * model output cannot inject markup. Links are restricted to http(s) and mailto.
 */
export function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const blocks = parseBlocks(text);
  return (
    <div className="md">
      {blocks.map((b, i) => {
        const last = streaming && i === blocks.length - 1;
        switch (b.t) {
          case "code":
            return (
              <pre key={i}>
                <code>{b.text}</code>
              </pre>
            );
          case "h":
            return b.level <= 2 ? <h3 key={i}>{inline(b.text)}</h3> : <h4 key={i}>{inline(b.text)}</h4>;
          case "ul":
          case "ol": {
            const L = b.t;
            return (
              <L key={i}>
                {b.items.map((it, j) => (
                  <li key={j} className={last && j === b.items.length - 1 ? "cursor" : undefined}>
                    {inline(it)}
                  </li>
                ))}
              </L>
            );
          }
          default:
            return (
              <p key={i} className={last ? "cursor" : undefined}>
                {inline(b.text)}
              </p>
            );
        }
      })}
      {streaming && !blocks.length && <p className="cursor" />}
    </div>
  );
}

type Block = { t: "p"; text: string } | { t: "h"; level: number; text: string } | { t: "code"; text: string } | { t: "ul" | "ol"; items: string[] };

function parseBlocks(src: string): Block[] {
  const out: Block[] = [];
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ t: "p", text: para.join("\n") });
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^```/.test(line)) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      out.push({ t: "code", text: body.join("\n") });
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      out.push({ t: "h", level: h[1]!.length, text: h[2]! });
      i++;
      continue;
    }
    const li = /^\s*([-*]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const ordered = /\d/.test(li[1]!);
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^\s*([-*]|\d+[.)])\s+(.*)$/.exec(lines[i]!);
        if (!m) {
          if (lines[i]!.trim() && /^\s{2,}/.test(lines[i]!) && items.length) {
            items[items.length - 1] += ` ${lines[i]!.trim()}`;
            i++;
            continue;
          }
          break;
        }
        items.push(m[2]!);
        i++;
      }
      out.push({ t: ordered ? "ol" : "ul", items });
      continue;
    }
    if (!line.trim()) flush();
    else para.push(line);
    i++;
  }
  flush();
  return out;
}

function inline(text: string): ReactNode {
  const nodes: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(<Fragment key={k++}>{lineBreaks(text.slice(last, m.index))}</Fragment>);
    const tok = m[0];
    if (tok.startsWith("`")) nodes.push(<code key={k++}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("**")) nodes.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("*")) nodes.push(<em key={k++}>{tok.slice(1, -1)}</em>);
    else {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)!;
      const href = lm[2]!;
      nodes.push(
        /^(https?:|mailto:)/i.test(href) ? (
          <a key={k++} href={href} target="_blank" rel="noreferrer noopener">
            {lm[1]}
          </a>
        ) : (
          <Fragment key={k++}>{lm[1]}</Fragment>
        ),
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(<Fragment key={k++}>{lineBreaks(text.slice(last))}</Fragment>);
  return nodes;
}

function lineBreaks(s: string): ReactNode {
  const parts = s.split("\n");
  return parts.map((p, i) => (
    <Fragment key={i}>
      {p}
      {i < parts.length - 1 && <br />}
    </Fragment>
  ));
}
