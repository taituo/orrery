import { describe, expect, it } from "vitest";
import { mentionedBots, type Bot, type InboundMessage, type Message } from "@orrery/core";
import { buildPrompt } from "../src/prompt.js";

const members = [
  { botId: "bot_ada", name: "Ada", lead: true },
  { botId: "bot_ada2", name: "Ada Lovelace", lead: false },
  { botId: "bot_scout", name: "Scout", lead: false },
  { botId: "bot_rel", name: "Release Bot", lead: false },
];

describe("group mentions", () => {
  it("matches names whole and case-insensitively, in order of mention", () => {
    expect(mentionedBots("@scout look, then @Ada", members)).toEqual(["bot_scout", "bot_ada"]);
    expect(mentionedBots("ask @Ada Lovelace", members)).toEqual(["bot_ada2"]);
    expect(mentionedBots("@Release Bot: hold", members)).toEqual(["bot_rel"]);
    expect(mentionedBots("mail ada@example.com or @Adam", members)).toEqual([]);
    expect(mentionedBots("@Scout-team", members)).toEqual([]);
  });
  it("broadcasts only when allowed", () => {
    expect(mentionedBots("@all please", members)).toEqual([]);
    expect(mentionedBots("@all please", members, { allowAll: true })).toHaveLength(4);
  });
});

describe("group prompts", () => {
  const bot = { id: "bot_scout", name: "Scout", instructions: "Research things." } as Bot;
  const inbound: InboundMessage = { messageId: "msg_3", threadId: "thr_g", botId: "bot_scout", teamId: "t", channel: "group", author: { type: "bot", id: "bot_ada", name: "Ada" }, parts: [{ type: "text", text: "@Scout check the dashboards" }], replyTo: null, hops: 1, receivedAt: "2026-10-30T10:00:00Z" };
  const msg = (id: string, role: Message["role"], author: Message["author"], text: string): Message => ({ id, threadId: "thr_g", role, author, parts: [{ type: "text", text }], runId: null, createdAt: "2026-10-30T09:59:00Z", meta: {} });

  it("tells the bot who is in the group, how to hand off, and what it missed", () => {
    const built = buildPrompt({
      bot,
      messages: [inbound],
      memoryBlock: "",
      knowledgeBlock: "",
      nowIso: "2026-10-30T10:00:00Z",
      history: [],
      group: {
        name: "incidents",
        topic: "On-call",
        members: members.map((m) => ({ name: m.name, lead: m.lead })),
        recent: [msg("msg_1", "user", { type: "user", id: "usr_1", name: "Alice" }, "payments are slow"), msg("msg_2", "assistant", { type: "bot", id: "bot_ada", name: "Ada" }, "Looking into it.")],
        botNames: new Map([["bot_ada", "Ada"]]),
      },
    });
    const text = built.promptParts.map((p) => (p.type === "text" ? p.text : "")).join("");
    expect(text).toContain('message in the group conversation "incidents" from Ada (another bot, handing work to you)');
    expect(text).toContain("Other bots: @Ada (lead), @Ada Lovelace, @Release Bot");
    expect(text).toContain("mention it with @Name");
    expect(text).toContain("Alice: payments are slow");
    expect(text).toContain("Ada: Looking into it.");
    expect(text.trim().endsWith("@Scout check the dashboards")).toBe(true);
  });
});
