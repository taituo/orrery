import type { Group } from "./domain.js";

/**
 * Bots of a group that a text @mentions, in order of first mention. Names match
 * case-insensitively and whole ("@Release Bot"); longer names win over their prefixes
 * ("@Ada Lovelace" is not also "@Ada"). `@all`, `@everyone` and `@here` mean every bot when
 * `allowAll` is set (people's messages; bots cannot broadcast).
 */
export function mentionedBots(text: string, members: Group["members"], opts: { allowAll?: boolean } = {}): string[] {
  if (opts.allowAll && /(^|[^\w@])@(all|everyone|here)\b/i.test(text)) return members.map((m) => m.botId);
  const hits: Array<{ botId: string; at: number }> = [];
  let rest = text;
  for (const m of [...members].sort((a, b) => b.name.length - a.name.length)) {
    const re = new RegExp(`(^|[^\\w@])@${m.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "gi");
    let match: RegExpExecArray | null;
    while ((match = re.exec(rest))) {
      hits.push({ botId: m.botId, at: match.index });
      rest = rest.slice(0, match.index) + " ".repeat(match[0].length) + rest.slice(match.index + match[0].length);
    }
  }
  return [...new Set(hits.sort((a, b) => a.at - b.at).map((h) => h.botId))];
}
