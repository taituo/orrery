import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { JsonRpcError, RPC_ERRORS } from "./jsonrpc.js";
import type {
  CreateTerminalRequest,
  ReadTextFileRequest,
  TerminalExitStatus,
  TerminalOutputResponse,
  WriteTextFileRequest,
} from "./protocol.js";

/**
 * Client-side ACP capabilities: `fs/*` and `terminal/*`.
 *
 * Kiro's built-in tools do their own I/O, but the ACP spec lets any agent delegate file and
 * terminal work to the client. These services run *inside the bot computer* (in the ACP
 * gateway), jailed to the configured workspace roots, so every compatible agent works.
 */
export class FsService {
  private readonly roots: string[];

  constructor(roots: string[], private readonly opts: { maxReadBytes?: number } = {}) {
    if (!roots.length) throw new Error("FsService needs at least one root");
    this.roots = roots.map((r) => path.resolve(r));
  }

  /** Resolve and confine a path to the workspace roots (symlink-safe for existing files). */
  async resolve(p: string, mustExist: boolean): Promise<string> {
    if (!path.isAbsolute(p)) throw new JsonRpcError(RPC_ERRORS.invalidParams, `path must be absolute: ${p}`);
    const normalized = path.resolve(p);
    let real = normalized;
    if (mustExist) {
      try {
        real = await realpath(normalized);
      } catch {
        throw new JsonRpcError(RPC_ERRORS.invalidParams, `file not found: ${p}`);
      }
    } else {
      // for new files, resolve the parent directory's real path
      try {
        const parent = await realpath(path.dirname(normalized));
        real = path.join(parent, path.basename(normalized));
      } catch {
        real = normalized;
      }
    }
    const inside = this.roots.some((root) => real === root || real.startsWith(root + path.sep));
    if (!inside) throw new JsonRpcError(RPC_ERRORS.invalidParams, `path outside workspace: ${p}`);
    return real;
  }

  async readTextFile(req: ReadTextFileRequest): Promise<{ content: string }> {
    const file = await this.resolve(req.path, true);
    const buf = await readFile(file);
    const max = this.opts.maxReadBytes ?? 16 * 1024 * 1024;
    if (buf.length > max) throw new JsonRpcError(RPC_ERRORS.invalidParams, `file too large (${buf.length} bytes)`);
    let content = buf.toString("utf8");
    if ((req.line ?? null) !== null || (req.limit ?? null) !== null) {
      const lines = content.split("\n");
      const start = Math.max(0, (req.line ?? 1) - 1);
      const end = req.limit ? start + req.limit : lines.length;
      content = lines.slice(start, end).join("\n");
    }
    return { content };
  }

  async writeTextFile(req: WriteTextFileRequest): Promise<Record<string, never>> {
    const file = await this.resolve(req.path, false);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, req.content, "utf8");
    return {};
  }
}

interface TerminalState {
  id: string;
  sessionId: string;
  child: ChildProcess;
  output: string;
  truncated: boolean;
  limit: number | null;
  exit: TerminalExitStatus | null;
  exited: Promise<TerminalExitStatus>;
}

export class TerminalService {
  private readonly terminals = new Map<string, TerminalState>();

  constructor(
    private readonly fs: FsService,
    private readonly opts: { defaultCwd: string; maxTerminals?: number; baseEnv?: Record<string, string> } ,
  ) {}

  async create(req: CreateTerminalRequest): Promise<{ terminalId: string }> {
    if (this.terminals.size >= (this.opts.maxTerminals ?? 32)) {
      throw new JsonRpcError(RPC_ERRORS.internalError, "too many terminals; release some first");
    }
    const cwd = req.cwd ? await this.fs.resolve(req.cwd, true) : this.opts.defaultCwd;
    const env: Record<string, string> = { ...(this.opts.baseEnv ?? (process.env as Record<string, string>)) };
    for (const v of req.env ?? []) env[v.name] = v.value;
    const child = spawn(req.command, req.args ?? [], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const id = `term_${randomUUID()}`;
    const state: TerminalState = {
      id,
      sessionId: req.sessionId,
      child,
      output: "",
      truncated: false,
      limit: req.outputByteLimit ?? null,
      exit: null,
      exited: Promise.resolve({}),
    };
    const append = (chunk: Buffer) => {
      state.output += chunk.toString("utf8");
      if (state.limit !== null && Buffer.byteLength(state.output, "utf8") > state.limit) {
        // ACP: keep the most recent output, truncating from the beginning on a char boundary.
        const buf = Buffer.from(state.output, "utf8");
        let start = buf.length - state.limit;
        while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
        state.output = buf.subarray(start).toString("utf8");
        state.truncated = true;
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    state.exited = new Promise((resolve) => {
      child.on("exit", (code, signal) => {
        state.exit = { exitCode: code, signal: signal ?? null };
        resolve(state.exit);
      });
      child.on("error", (err) => {
        append(Buffer.from(`\n[spawn error] ${err.message}\n`));
        state.exit = { exitCode: 127, signal: null };
        resolve(state.exit);
      });
    });
    this.terminals.set(id, state);
    return { terminalId: id };
  }

  private get(terminalId: string): TerminalState {
    const t = this.terminals.get(terminalId);
    if (!t) throw new JsonRpcError(RPC_ERRORS.invalidParams, `unknown terminal ${terminalId}`);
    return t;
  }

  output(terminalId: string): TerminalOutputResponse {
    const t = this.get(terminalId);
    return { output: t.output, truncated: t.truncated, exitStatus: t.exit };
  }

  async waitForExit(terminalId: string, signal?: AbortSignal): Promise<TerminalExitStatus> {
    const t = this.get(terminalId);
    if (!signal) return t.exited;
    return Promise.race([
      t.exited,
      new Promise<TerminalExitStatus>((_, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })),
    ]);
  }

  kill(terminalId: string): Record<string, never> {
    const t = this.get(terminalId);
    if (!t.exit) t.child.kill("SIGTERM");
    return {};
  }

  release(terminalId: string): Record<string, never> {
    const t = this.terminals.get(terminalId);
    if (!t) return {};
    if (!t.exit) t.child.kill("SIGKILL");
    this.terminals.delete(terminalId);
    return {};
  }

  /** Release everything belonging to a session (session closed / connection lost). */
  releaseSession(sessionId: string): void {
    for (const t of [...this.terminals.values()]) if (t.sessionId === sessionId) this.release(t.id);
  }

  releaseAll(): void {
    for (const id of [...this.terminals.keys()]) this.release(id);
  }
}
