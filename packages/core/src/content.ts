/**
 * Provider-neutral content model. It is a superset-compatible projection of ACP ContentBlock
 * (text, image, audio, resource_link, resource) so Kiro output can be stored losslessly, and
 * it maps cleanly onto OpenAI-compatible chat message parts.
 */
export interface Annotations {
  audience?: Array<"assistant" | "user"> | null;
  lastModified?: string | null;
  priority?: number | null;
}

export type ContentPart =
  | { type: "text"; text: string; annotations?: Annotations | null }
  | { type: "image"; mimeType: string; data?: string; uri?: string | null; annotations?: Annotations | null }
  | { type: "audio"; mimeType: string; data: string; annotations?: Annotations | null }
  | {
      type: "resource_link";
      uri: string;
      name: string;
      mimeType?: string | null;
      title?: string | null;
      description?: string | null;
      size?: number | null;
      annotations?: Annotations | null;
    }
  | {
      type: "resource";
      resource: { uri: string; mimeType?: string | null; text?: string; blob?: string };
      annotations?: Annotations | null;
    };

export function textPart(text: string): ContentPart {
  return { type: "text", text };
}

/** Concatenate the human-readable text of a list of parts (images/audio are summarized). */
export function partsToText(parts: readonly ContentPart[]): string {
  const out: string[] = [];
  for (const p of parts) {
    switch (p.type) {
      case "text":
        out.push(p.text);
        break;
      case "resource":
        if (p.resource.text !== undefined) out.push(p.resource.text);
        else out.push(`[resource ${p.resource.uri}]`);
        break;
      case "resource_link":
        out.push(`[${p.title ?? p.name}](${p.uri})`);
        break;
      case "image":
        out.push(`[image ${p.mimeType}]`);
        break;
      case "audio":
        out.push(`[audio ${p.mimeType}]`);
        break;
    }
  }
  return out.join("");
}

/** Merge adjacent text parts (used when accumulating streamed chunks). */
export function appendPart(parts: ContentPart[], next: ContentPart): ContentPart[] {
  const last = parts[parts.length - 1];
  if (last && last.type === "text" && next.type === "text" && !last.annotations && !next.annotations) {
    parts[parts.length - 1] = { type: "text", text: last.text + next.text };
    return parts;
  }
  parts.push(next);
  return parts;
}
