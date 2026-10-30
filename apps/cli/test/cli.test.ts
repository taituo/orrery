import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { main, parseArgs } from "../src/index.js";
import type { Io } from "../src/io.js";

function io(env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const o: Io = { stdin: new PassThrough(), stdout: new PassThrough(), isTTY: false, out: (l) => void out.push(l), err: (l) => void err.push(l), write: (s) => void out.push(s), env };
  return { io: o, out, err };
}

describe("orrery CLI", () => {
  it("parses flags, values and messages", () => {
    expect(parseArgs(["ask", "ada", "hello", "world", "--approve", "--thread", "thr_1"])).toEqual({ _: ["ask", "ada", "hello", "world"], flags: { approve: true, thread: "thr_1" } });
    expect(parseArgs(["bots", "create", "Ada", "--engine=opencode", "-m", "hi"])).toEqual({ _: ["bots", "create", "Ada"], flags: { engine: "opencode", message: "hi" } });
  });

  it("explains how to sign in, and prints help", async () => {
    const a = io({ HOME: "/nonexistent-home" });
    expect(await main(["bots"], a.io)).toBe(2);
    expect(a.err.join("\n")).toContain("orrery login");
    const b = io();
    expect(await main(["help"], b.io)).toBe(0);
    expect(b.out.join("\n")).toContain("orrery ask <bot|group> <message…>");
  });

  it("reports an unreachable server clearly", async () => {
    const a = io({ ORRERY_URL: "http://127.0.0.1:9", ORRERY_TOKEN: "x" });
    expect(await main(["whoami"], a.io)).toBe(1);
    expect(a.err.join("\n")).toMatch(/cannot reach http:\/\/127\.0\.0\.1:9/);
  });
});
