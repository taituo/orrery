import { describe, expect, it } from "vitest";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { signToken, type AgentEvent } from "@orrery/core";
import { GATEWAY_TOKEN_AUDIENCE, KiroV3Adapter, classifyAgentFailure, connectWebSocket, runAcpTurn, spawnAgent } from "@orrery/acp";
import { AcpGateway, startGatewayServer, type AgentProcess } from "@orrery/acp-gateway";

const cli = path.resolve(__dirname, "../src/mock-kiro-cli.ts");
const SECRET = "test-secret-test-secret";

describe("agent that cannot start (Kiro not signed in)", () => {
  it("classifies the real CLI's not-logged-in exit", () => {
    const f = classifyAgentFailure("error: You are not logged in, please log in with kiro-cli login\n", { code: 1, signal: null });
    expect(f.code).toBe("agent_auth_required");
    expect(f.message).toContain("KIRO_API_KEY");
    expect(classifyAgentFailure("segfault\n", { code: 139, signal: null }).code).toBe("agent_start_failed");
  });

  it("gateway reports it on /readyz and turns fail fast with auth.required (no retry loop)", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "gw-auth-"));
    const gateway = new AcpGateway({
      workspaceRoots: [ws],
      defaultCwd: ws,
      spawnAgent: (): AgentProcess => {
        let tail = "";
        const p = spawnAgent({
          command: process.execPath,
          args: ["--conditions=@orrery/source", "--import", "tsx", cli, "acp", "--agent-engine=v3"],
          env: { MOCK_KIRO_REQUIRE_AUTH: "1", KIRO_API_KEY: "" },
          onStderr: (line) => (tail += line + "\n"),
        });
        return { transport: p.transport, pid: p.child.pid ?? null, exited: p.exited, kill: p.kill, stderrTail: () => tail };
      },
    });
    void gateway.start();
    const server = await startGatewayServer(gateway, { port: 0, host: "127.0.0.1", tokenSecret: SECRET, computerId: "cmp_auth" });
    const port = (server.address() as { port: number }).port;
    try {
      for (let i = 0; i < 100 && !gateway.lastError; i++) await new Promise((r) => setTimeout(r, 50));
      expect(gateway.lastError?.code).toBe("agent_auth_required");

      const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(ready.status).toBe(503);
      expect(((await ready.json()) as { error: { code: string } }).error.code).toBe("agent_auth_required");

      const events: AgentEvent[] = [];
      const token = signToken({ sub: "cmp_auth", aud: GATEWAY_TOKEN_AUDIENCE, exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
      const started = Date.now();
      const turn = runAcpTurn(
        { connect: () => connectWebSocket({ url: `ws://127.0.0.1:${port}/acp`, token }), adapter: new KiroV3Adapter(), viaGateway: true },
        { requestKey: "run_auth", messageId: "m", session: { cwd: ws, mcpServers: [], binding: {} }, prompt: [{ type: "text", text: "hi" }] },
        { onEvent: (e) => void events.push(e), decidePermission: async () => ({ outcome: "cancelled" }) },
        new AbortController().signal,
      );
      await expect(turn).rejects.toMatchObject({ code: "provider_unavailable", retryable: false });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(events).toContainEqual(expect.objectContaining({ type: "auth.required", kind: "agent_login" }));
    } finally {
      server.close();
      await gateway.stop();
    }
  }, 30_000);
});
