import { OrreryError, mentionedBots, type ContentPart, type Group, type InboundMessage } from "@orrery/core";
import type { Db } from "@orrery/db";
import type { Delivery } from "./delivery.js";

/**
 * Group routing. A message to a group goes to the bots it @mentions (`@all` / `@everyone`: every
 * bot); with no mention, to the lead bot. See mentionedBots for the matching rules.
 */
export function targetsFor(text: string, group: Group): string[] {
  const mentioned = mentionedBots(text, group.members, { allowAll: true });
  if (mentioned.length) return mentioned;
  const lead = group.members.find((m) => m.lead) ?? group.members[0];
  if (!lead) throw new OrreryError("conflict", "the group has no bots");
  return [lead.botId];
}

/** Store a person's message in the group and deliver it to the bots it is for. */
export async function routeGroupMessage(
  deps: { db: Db; delivery: Delivery },
  p: { teamId: string },
  group: Group,
  parts: ContentPart[],
  author: InboundMessage["author"],
): Promise<{ messageId: string; targets: string[]; delivered: boolean }> {
  const text = parts.map((x) => (x.type === "text" ? x.text : "")).join(" ");
  const targets = targetsFor(text, group);
  const { message, delivered } = await deps.delivery.submitFanout(
    { teamId: p.teamId, threadId: group.threadId, role: "user", author, parts, meta: { targets } },
    { threadId: group.threadId, teamId: p.teamId, channel: "group", author, parts, replyTo: null, hops: 0 },
    targets,
  );
  return { messageId: message.id, targets, delivered };
}
