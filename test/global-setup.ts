import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";

/**
 * Starts a throwaway PostgreSQL (with pgvector) for integration tests unless TEST_DATABASE_URL
 * is already provided (CI uses a service container). Runs as the `postgres` OS user when the
 * test process is root, since postgres refuses to run as root.
 */
const PG_BIN = process.env.PG_BIN ?? "/usr/lib/postgresql/16/bin";

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

let proc: ChildProcess | null = null;
let dataDir: string | null = null;
let stopCmd: [string, string[]] | null = null;

export async function setup(): Promise<void> {
  if (process.env.TEST_DATABASE_URL) return;
  if (!existsSync(path.join(PG_BIN, "initdb"))) {
    process.env.TEST_DATABASE_URL_UNAVAILABLE = "1";
    return;
  }
  const asRoot = process.getuid?.() === 0;
  const wrap = (cmd: string, args: string[]): [string, string[]] => (asRoot ? ["runuser", ["-u", "postgres", "--", cmd, ...args]] : [cmd, args]);
  dataDir = mkdtempSync(path.join(tmpdir(), "orrery-pg-"));
  chmodSync(dataDir, 0o777);
  const pgdata = path.join(dataDir, "data");
  const [c1, a1] = wrap(path.join(PG_BIN, "initdb"), ["-D", pgdata, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--no-instructions"]);
  execFileSync(c1, a1, { stdio: "ignore" });
  const port = await freePort();
  const [c2, a2] = wrap(path.join(PG_BIN, "postgres"), ["-D", pgdata, "-p", String(port), "-k", dataDir, "-c", "listen_addresses=127.0.0.1", "-c", "fsync=off", "-c", "max_connections=200"]);
  proc = spawn(c2, a2, { stdio: "ignore" });
  proc.unref();
  stopCmd = wrap(path.join(PG_BIN, "pg_ctl"), ["stop", "-D", pgdata, "-m", "immediate", "-s"]);
  const url = `postgres://postgres@127.0.0.1:${port}/postgres`;
  for (let i = 0; i < 100; i++) {
    try {
      execFileSync(path.join(PG_BIN, "pg_isready"), ["-h", "127.0.0.1", "-p", String(port)], { stdio: "ignore" });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  process.env.TEST_DATABASE_URL = url;
}

export async function teardown(): Promise<void> {
  if (proc) {
    const exited = new Promise((r) => (proc!.exitCode !== null ? r(null) : proc!.once("exit", r)));
    try {
      if (stopCmd) execFileSync(stopCmd[0], stopCmd[1], { stdio: "ignore", timeout: 10_000 });
    } catch {
      proc.kill("SIGKILL");
    }
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
}
