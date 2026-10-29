#!/usr/bin/env node
// End-to-end check of a running Orrery stack through its public API:
//   API → Temporal (bot + turn workflows) → worker → ACP gateway → Kiro (or the mock) → back,
// including a tool-permission round trip decided through the approvals API.
//
//   node scripts/e2e.mjs --api http://localhost:8090 --token dev-token [--mock] [--timeout 180]
//     [--crash-cmd "docker compose kill -s SIGKILL worker" --restart-cmd "docker compose up -d worker"]
//
// --mock expects the wire-faithful mock Kiro CLI (ORRERY_COMPUTER_TARGET=computer-mock);
// without it the prompt is phrased for a real kiro-cli.
// --crash-cmd/--restart-cmd (mock only) add a durability phase: the worker is killed mid-turn,
// restarted, and the turn must finish with every piece of output exactly once and no re-prompt.

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"]);
    return acc;
  }, []),
);
const API = (args.api ?? process.env.ORRERY_API ?? "http://localhost:8090").replace(/\/+$/, "");
const TOKEN = args.token ?? process.env.ORRERY_DEV_TOKEN ?? "dev-token";
const MOCK = args.mock === "true";
const TIMEOUT = Number(args.timeout ?? 180) * 1000;
const MARKER = `orrery-e2e-${Math.random().toString(36).slice(2, 8)}`;

const started = Date.now();
const log = (...m) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s]`, ...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = async (cmd) => {
  const { execSync } = await import("node:child_process");
  log("$", cmd);
  execSync(cmd, { stdio: "inherit" });
};

async function call(method, path, body) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  const json = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${text.slice(0, 300)}`);
  return json;
}

async function until(what, fn, every = 1000) {
  for (;;) {
    const v = await fn().catch((e) => (process.env.E2E_DEBUG && log(`${what}: ${e.message}`), undefined));
    if (v) return v;
    if (Date.now() - started > TIMEOUT) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}

try {
  await until("API ready", async () => (await fetch(`${API}/readyz`)).ok, 2000);
  log("API ready");

  const { bot } = await call("POST", "/v1/bots", {
    name: "E2E check",
    description: "end-to-end check",
    instructions: "You are a test bot. Follow instructions exactly and keep answers short.",
    primary: { kind: "kiro-acp", engine: process.env.E2E_ENGINE ?? "v3" },
    policy: {
      defaultEffect: "ask",
      rules: [{ id: "ask-shell", effect: "ask", capability: "shell", resource: "**" }],
      guardrail: { enabled: false, askAbove: 0.5, denyAbove: 0.92 },
      approvalTimeoutMinutes: 30,
      allowPersistentConsent: false,
    },
    memory: { enabled: true, autoExtract: false, recallK: 4, shareScope: "bot", coreMemoryCharLimit: 2000 },
  });
  log("bot", bot.id);
  const { thread } = await call("POST", `/v1/bots/${bot.id}/threads`, { title: "e2e" });

  const prompt = MOCK ? `hello e2e\nrun: echo ${MARKER}` : `Run the shell command \`echo ${MARKER}\` and reply with exactly its output.`;
  const sent = await call("POST", `/v1/threads/${thread.id}/messages`, { text: prompt });
  log("message", sent.messageId, "delivery:", sent.delivery);

  // The mock always asks for permission; a real agent may run a harmless command without asking.
  const first = await until("approval request or turn end", async () => {
    const a = (await call("GET", `/v1/approvals?botId=${bot.id}`)).approvals[0];
    if (a) return { approval: a };
    const r = (await call("GET", `/v1/threads/${thread.id}/runs`)).runs[0];
    return r && !["queued", "running", "waiting_approval"].includes(r.status) ? { done: true } : undefined;
  });
  if (first.approval) {
    const approval = first.approval;
    const allow = approval.options.find((o) => o.kind === "allow_once") ?? approval.options.find((o) => o.kind === "allow_always");
    if (!allow) throw new Error(`agent offered no allow option: ${JSON.stringify(approval.options)}`);
    log("approval", approval.id, "→", allow.name, `(${approval.title})`);
    await call("POST", `/v1/approvals/${approval.id}/decide`, { optionId: allow.optionId, note: "e2e" });
  } else if (MOCK) {
    throw new Error("the mock agent finished without asking for permission");
  } else {
    log("agent ran the command without asking for permission");
  }

  const run = await until("turn to finish", async () => {
    const { runs } = await call("GET", `/v1/threads/${thread.id}/runs`);
    const r = runs[0];
    return r && !["queued", "running", "waiting_approval"].includes(r.status) ? r : undefined;
  });
  log("run", run.id, run.status, run.stopReason ?? "");
  if (run.status !== "completed") throw new Error(`run ended ${run.status}: ${JSON.stringify(run.error)}`);

  const { messages } = await call("GET", `/v1/threads/${thread.id}/messages`);
  const answer = messages.filter((m) => m.role === "assistant").map((m) => m.parts.map((p) => p.text ?? "").join("")).join("\n");
  log("answer:", answer.slice(0, 200).replace(/\n/g, " "));
  const expected = MOCK ? `Ran \`echo ${MARKER}\`` : MARKER;
  if (!answer.includes(expected)) throw new Error(`assistant answer does not contain ${expected}`);

  const { events } = await call("GET", `/v1/runs/${run.id}/events`);
  const types = new Set(events.map((e) => e.event.type));
  for (const t of ["turn.started", "tool.call", "turn.completed", ...(MOCK ? ["approval.requested", "approval.resolved"] : [])]) if (!types.has(t)) throw new Error(`missing ${t} event`);
  log(`events ok (${events.length}): ${[...types].join(", ")}`);

  // Second turn on the same thread: the agent session is resumed, not recreated.
  const firstSession = events.find((e) => e.event.type === "turn.started")?.event.sessionId;
  await call("POST", `/v1/threads/${thread.id}/messages`, { text: MOCK ? "second turn" : "Reply with the word: second" });
  const run2 = await until("second turn to finish", async () => {
    const { runs } = await call("GET", `/v1/threads/${thread.id}/runs`);
    const r = runs.find((x) => x.id !== run.id);
    return r && !["queued", "running", "waiting_approval"].includes(r.status) ? r : undefined;
  });
  if (run2.status !== "completed") throw new Error(`second run ended ${run2.status}`);
  const ev2 = (await call("GET", `/v1/runs/${run2.id}/events`)).events;
  const secondSession = ev2.find((e) => e.event.type === "turn.started")?.event.sessionId;
  if (firstSession && secondSession !== firstSession) throw new Error(`session not resumed (${firstSession} → ${secondSession})`);
  log("second turn", run2.id, "same agent session:", secondSession);

  if (MOCK && args["crash-cmd"]) {
    const { thread: t3 } = await call("POST", `/v1/bots/${bot.id}/threads`, { title: "durability" });
    await call("POST", `/v1/threads/${t3.id}/messages`, { text: `durable start\nsleep: 15000\ndurable done ${MARKER}` });
    const r3 = await until("durability turn to start", async () => (await call("GET", `/v1/threads/${t3.id}/runs`)).runs.find((r) => r.status === "running"), 300);
    await sleep(1500);
    await sh(args["crash-cmd"]);
    await sleep(1000);
    await sh(args["restart-cmd"]);
    const done = await until("durability turn to finish after the crash", async () => {
      const r = (await call("GET", `/v1/threads/${t3.id}/runs`)).runs.find((x) => x.id === r3.id);
      return r && !["queued", "running", "waiting_approval"].includes(r.status) ? r : undefined;
    }, 2000);
    if (done.status !== "completed") throw new Error(`durability run ended ${done.status}`);
    const text = (await call("GET", `/v1/threads/${t3.id}/messages`)).messages.filter((m) => m.role === "assistant").map((m) => m.parts.map((p) => p.text ?? "").join("")).join("");
    const count = (needle) => text.split(needle).length - 1;
    const runsOnThread = (await call("GET", `/v1/threads/${t3.id}/runs`)).runs.length;
    if (count("durable start") !== 1 || count(`durable done ${MARKER}`) !== 1 || runsOnThread !== 1) throw new Error(`durability: start×${count("durable start")} done×${count(`durable done ${MARKER}`)} runs=${runsOnThread}`);
    log("durability ok: worker crashed mid-turn, turn resumed without re-prompting, output exactly once");
  }

  await call("DELETE", `/v1/bots/${bot.id}`);
  log("PASS");
} catch (err) {
  log("FAIL:", err instanceof Error ? err.message : err);
  process.exit(1);
}
