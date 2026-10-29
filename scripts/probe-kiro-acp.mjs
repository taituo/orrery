#!/usr/bin/env node
// Probes a kiro-cli binary over ACP (stdio, newline-delimited JSON-RPC) and prints what it
// advertises: protocol version, agent info, capabilities, Kiro extension methods, auth methods,
// and — when credentials are present (KIRO_API_KEY) — the session setup (modes, models, config
// options). No dependencies; used by CI against the real CLI and handy for local checks.
//
//   node scripts/probe-kiro-acp.mjs [path-to-kiro-cli] [v3|v2|both]
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const bin = process.argv[2] ?? "kiro-cli";
const which = process.argv[3] ?? "both";
const cwd = mkdtempSync(path.join(tmpdir(), "kiro-probe-"));

function probe(label, args) {
  return new Promise((resolve) => {
    const out = { label, args, stderr: "", responses: {}, notifications: [], requests: [], exit: null };
    const child = spawn(bin, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    let id = 0;
    const pending = new Map();
    const send = (method, params) =>
      new Promise((res) => {
        const myId = ++id;
        pending.set(myId, res);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
        setTimeout(() => pending.has(myId) && (pending.delete(myId), res({ timeout: true })), 20_000);
      });
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          out.notifications.push({ nonJson: line.slice(0, 200) });
          continue;
        }
        if (m.id !== undefined && (m.result !== undefined || m.error !== undefined) && pending.has(m.id)) {
          pending.get(m.id)(m);
          pending.delete(m.id);
        } else if (m.method && m.id !== undefined) {
          out.requests.push({ method: m.method });
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } }) + "\n");
        } else if (m.method) {
          out.notifications.push({ method: m.method, kind: m.params?.update?.sessionUpdate ?? m.params?._meta?.kiro?.kind });
        }
      }
    });
    child.stderr.on("data", (d) => (out.stderr += d).length > 4000 && (out.stderr = out.stderr.slice(-4000)));
    child.on("exit", (code, signal) => (out.exit = { code, signal }));
    child.on("error", (err) => {
      out.exit = { error: String(err) };
      resolve(out);
    });
    (async () => {
      const init = await send("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, _meta: { kiro: { openExternalUrl: true } } },
        clientInfo: { name: "orrery-probe", version: "0.1.0" },
      });
      out.responses.initialize = init;
      if (init.result) {
        const ses = await send("session/new", { cwd, mcpServers: [] });
        out.responses["session/new"] = ses;
      }
      await new Promise((r) => setTimeout(r, 1500));
      child.kill("SIGTERM");
      setTimeout(() => resolve(out), 500);
    })();
  });
}

const runs = [];
if (which === "both" || which === "v3") runs.push(await probe("v3", ["acp", "--agent-engine=v3"]));
if (which === "both" || which === "v2") runs.push(await probe("v2", ["acp"]));

for (const r of runs) {
  const init = r.responses.initialize?.result;
  const ses = r.responses["session/new"];
  const summary = {
    engine: r.label,
    args: r.args.join(" "),
    initialize: init
      ? {
          protocolVersion: init.protocolVersion,
          agentInfo: init.agentInfo,
          authMethods: (init.authMethods ?? []).map((m) => m.id ?? m.name),
          loadSession: init.agentCapabilities?.loadSession,
          promptCapabilities: init.agentCapabilities?.promptCapabilities,
          mcpCapabilities: init.agentCapabilities?.mcpCapabilities,
          sessionCapabilities: init.agentCapabilities?.sessionCapabilities,
          kiroMeta: init.agentCapabilities?._meta?.kiro ?? init.agentCapabilities?._meta ?? null,
        }
      : (r.responses.initialize ?? null),
    sessionNew: ses?.result
      ? {
          sessionId: Boolean(ses.result.sessionId),
          modes: ses.result.modes?.availableModes?.map((m) => m.id),
          currentMode: ses.result.modes?.currentModeId,
          models: ses.result.models?.availableModels?.map((m) => m.modelId),
          currentModel: ses.result.models?.currentModelId,
          configOptions: ses.result.configOptions?.map((o) => `${o.id}=${o.currentValue}`),
          meta: ses.result._meta ?? null,
        }
      : (ses?.error ?? ses ?? null),
    agentRequests: [...new Set(r.requests.map((x) => x.method))],
    notifications: [...new Set(r.notifications.map((n) => n.method ? `${n.method}${n.kind ? `:${n.kind}` : ""}` : `nonJson:${n.nonJson}`))].slice(0, 30),
    exit: r.exit,
    stderrTail: r.stderr.trim().split("\n").slice(-8),
  };
  console.log(JSON.stringify(summary, null, 2));
}
