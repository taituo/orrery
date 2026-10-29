#!/usr/bin/env node
/**
 * Drop-in stand-in for `kiro-cli` used by tests, CI and offline demos:
 *   KIRO_CLI_PATH="node --conditions=@orrery/source --import tsx packages/testkit/src/mock-kiro-cli.ts"
 * MOCK_KIRO_GENERATION=v2 makes it behave like a CLI 2.x binary (rejects --agent-engine).
 * MOCK_KIRO_REQUIRE_AUTH=1 makes it refuse to start without KIRO_API_KEY, exactly like the real
 * CLI (observed with kiro-cli 2.35.1): one stderr line, exit code 1, before ACP `initialize`.
 */
import { NdjsonStreamTransport } from "@orrery/acp";
import { LaunchError, MockKiroAgent, validateLaunch, type MockGeneration } from "./mock-kiro.js";

const generation = (process.env.MOCK_KIRO_GENERATION === "v2" ? "v2" : "v3") as MockGeneration;
const argv = process.argv.slice(2);

try {
  validateLaunch(argv, generation);
} catch (err) {
  if (err instanceof LaunchError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  throw err;
}

if (process.env.MOCK_KIRO_REQUIRE_AUTH === "1" && !process.env.KIRO_API_KEY) {
  process.stderr.write("error: You are not logged in, please log in with kiro-cli login\n");
  process.exit(1);
}

const transport = new NdjsonStreamTransport(process.stdin, process.stdout, (line) => process.stderr.write(`[mock-kiro] ignored non-JSON line: ${line.slice(0, 120)}\n`));
const agent = new MockKiroAgent(transport, {
  generation,
  argv,
  ...(process.env.MOCK_KIRO_STATE_DIR ? { stateDir: process.env.MOCK_KIRO_STATE_DIR } : {}),
});
process.stderr.write(`[mock-kiro] ready (engine=${agent.engine})\n`);
transport.onClose(() => process.exit(0));
