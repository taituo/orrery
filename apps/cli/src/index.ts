import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ApiError, OrreryClient } from "./client.js";
import { ChatSession } from "./chat.js";
import { style, table, type Io } from "./io.js";

export const VERSION = "0.1.0";

const BOOLEAN_FLAGS = new Set(["json", "approve", "always", "thoughts", "help", "new", "yes"]);

export interface Args {
  _: string[];
  flags: Record<string, string | true>;
}

export function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) out.flags[key] = a.slice(eq + 1);
      else if (BOOLEAN_FLAGS.has(key) || i + 1 >= argv.length || argv[i + 1]!.startsWith("--")) out.flags[key] = true;
      else out.flags[key] = argv[++i]!;
    } else if (a === "-h") out.flags.help = true;
    else if (a === "-m" && i + 1 < argv.length) out.flags.message = argv[++i]!;
    else out._.push(a);
  }
  return out;
}

interface Config {
  url: string;
  token: string;
}

function configPath(env: Io["env"]): string {
  const base = env.XDG_CONFIG_HOME || path.join(env.HOME || homedir(), ".config");
  return path.join(base, "orrery", "config.json");
}

function loadConfig(env: Io["env"]): Config | null {
  if (env.ORRERY_URL && env.ORRERY_TOKEN) return { url: env.ORRERY_URL, token: env.ORRERY_TOKEN };
  const p = configPath(env);
  if (!existsSync(p)) return null;
  const c = JSON.parse(readFileSync(p, "utf8")) as Config;
  return { url: env.ORRERY_URL || c.url, token: env.ORRERY_TOKEN || c.token };
}

const HELP = `orrery ${VERSION} — talk to your Orrery bots from the terminal

  orrery login --url <url> --token <token>   save credentials (or set ORRERY_URL / ORRERY_TOKEN)
  orrery whoami | status                     who you are; what this install has configured

  orrery bots                                list bots
  orrery bots create <name> [--engine kiro|kiro-v2|opencode|openai] [--model <id>]
                     [--instructions <text>] [--provider <id>]
  orrery bots delete <bot>
  orrery ask <bot|group> <message…>          one turn: stream the answer, then exit
         [--thread <id>] [--approve] [--json] [--timeout <s>]
                                             (--approve: allow tool calls once, automatically)
  orrery chat <bot|group> [--thread <id>]    interactive conversation (approvals inline)
  orrery threads <bot>                       conversations of a bot

  orrery groups                              group chats (bots + people)
  orrery groups create <name> <bot> <bot>…   a group with 2–6 bots (the first one leads)

  orrery approvals                           pending approvals
  orrery approve <id> [--always]             allow (once, or the agent's "always" option)
  orrery deny <id>

  orrery tokens | tokens create <name> [--role member] [--for <person>] [--days <n>]
  orrery tokens revoke <id>
  orrery env                                 agent credentials (names only)
  orrery env set <NAME> [value]              e.g. KIRO_API_KEY, ANTHROPIC_API_KEY (value from stdin if omitted)
  orrery env rm <NAME>
  orrery mcp [--client claude|cursor|vscode] MCP client configuration for this install

Bots and groups are matched by id or name.`;

export async function main(argv: string[], io: Io): Promise<number> {
  const args = parseArgs(argv);
  const [cmd, sub, ...rest] = args._;
  if (!cmd || cmd === "help" || args.flags.help) {
    io.out(HELP);
    return 0;
  }
  if (cmd === "version" || cmd === "--version") {
    io.out(VERSION);
    return 0;
  }
  try {
    if (cmd === "login") return await login(args, io);
    if (cmd === "logout") {
      rmSync(configPath(io.env), { force: true });
      io.out("Signed out.");
      return 0;
    }
    const cfg = loadConfig(io.env);
    if (!cfg) {
      io.err("Not signed in. Run: orrery login --url <url> --token <token>");
      return 2;
    }
    const api = new OrreryClient(cfg.url, cfg.token);
    const json = Boolean(args.flags.json);
    const print = (data: unknown, human: () => string) => io.out(json ? JSON.stringify(data, null, 2) : human());

    switch (cmd) {
      case "whoami": {
        const me = await api.get<{ userId: string; teamId: string; role: string; name: string | null; via?: string }>("/v1/me");
        print(me, () => `${me.name ?? me.userId} (${me.role}) in ${me.teamId}${me.via ? style.dim(` · ${me.via}`) : ""}\n${style.dim(cfg.url)}`);
        return 0;
      }
      case "status": {
        const s = await api.get<Record<string, unknown> & { engines: Record<string, string>; agentEnv: string[]; providers: { chat: string[] }; bots: number; computers: string }>("/v1/setup");
        print(s, () =>
          table(
            [
              ["computers", s.computers],
              ["kiro", s.engines.kiro ?? "—"],
              ["opencode", s.engines.opencode ?? "—"],
              ["agent credentials", s.agentEnv.join(", ") || "none"],
              ["chat providers", s.providers.chat.join(", ") || "none"],
              ["bots", String(s.bots)],
            ],
          ),
        );
        return 0;
      }
      case "bots":
        return await bots(api, io, sub, rest, args, json);
      case "ask":
      case "chat":
        return await chat(api, io, cmd, [sub, ...rest].filter((x): x is string => Boolean(x)), args);
      case "threads": {
        if (!sub) throw new UsageError("orrery threads <bot>");
        const bot = await findBot(api, sub);
        const { threads } = await api.get<{ threads: Array<{ id: string; title: string; channel: string; lastActivityAt?: string; updatedAt?: string }> }>(`/v1/bots/${bot.id}/threads`);
        print(threads, () => table(threads.map((t) => [t.id, t.title, t.channel, t.lastActivityAt ?? t.updatedAt ?? ""]), ["id", "title", "channel", "last activity"]));
        return 0;
      }
      case "groups":
        return await groups(api, io, sub, rest, json);
      case "approvals": {
        const { approvals } = await api.get<{ approvals: Array<{ id: string; title: string; botId: string; capability: string; resource: string; options: Array<{ kind: string; name: string }> }> }>("/v1/approvals");
        print(approvals, () => (approvals.length ? table(approvals.map((a) => [a.id, a.title, `${a.capability}: ${a.resource}`, a.options.map((o) => o.kind).join("/")]), ["id", "tool", "what", "options"]) : "No pending approvals."));
        return 0;
      }
      case "approve":
      case "deny": {
        if (!sub) throw new UsageError(`orrery ${cmd} <approval id>`);
        const { approval } = await api.get<{ approval: { id: string; title: string; options: Array<{ optionId: string; kind: string; name: string }> } }>(`/v1/approvals/${sub}`);
        const want = cmd === "deny" ? ["reject_once", "reject_always"] : args.flags.always ? ["allow_always", "allow_once"] : ["allow_once", "allow_always"];
        const opt = want.map((k) => approval.options.find((o) => o.kind === k)).find(Boolean);
        if (!opt) throw new UsageError(`the agent offered no ${cmd === "deny" ? "reject" : "allow"} option (${approval.options.map((o) => o.kind).join(", ")})`);
        await api.post(`/v1/approvals/${sub}/decide`, { optionId: opt.optionId, note: "orrery CLI" });
        io.out(`${cmd === "deny" ? "Denied" : "Approved"}: ${approval.title} (${opt.name})`);
        return 0;
      }
      case "tokens":
        return await tokens(api, io, sub, rest, args, json);
      case "env":
        return await agentEnv(api, io, sub, rest, json);
      case "mcp": {
        const client = String(args.flags.client ?? "generic");
        const url = `${cfg.url.replace(/\/+$/, "")}/mcp`;
        const server = { type: "http", url, headers: { Authorization: `Bearer ${cfg.token}` } };
        const conf = client === "vscode" ? { servers: { orrery: server } } : { mcpServers: { orrery: server } };
        io.out(JSON.stringify(conf, null, 2));
        if (!json) io.err(style.dim(`\nPaste into your MCP client's config (${client}). Tools: list bots, ask a bot, approvals, conversations.`));
        return 0;
      }
      default:
        throw new UsageError(`unknown command "${cmd}" (orrery help)`);
    }
  } catch (err) {
    if (err instanceof UsageError) io.err(err.message);
    else if (err instanceof ApiError) io.err(style.red(err.status === 401 ? "Not authorized: the token is invalid or revoked (orrery login)." : `${err.message}${err.status ? style.dim(` (${err.status} ${err.code})`) : ""}`));
    else io.err(style.red((err as Error).stack ?? String(err)));
    return err instanceof UsageError ? 2 : 1;
  }
}

class UsageError extends Error {}

async function login(args: Args, io: Io): Promise<number> {
  const url = String(args.flags.url ?? io.env.ORRERY_URL ?? "");
  let token = String(args.flags.token ?? io.env.ORRERY_TOKEN ?? "");
  if (!url) throw new UsageError("orrery login --url <url> --token <token>");
  if (!token && !io.isTTY) token = (await readStdin(io)).trim();
  if (!token) throw new UsageError("missing --token (or pipe it on stdin)");
  const me = await new OrreryClient(url, token).get<{ name: string | null; userId: string; role: string; teamId: string }>("/v1/me");
  const p = configPath(io.env);
  mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify({ url: url.replace(/\/+$/, ""), token }, null, 2), { mode: 0o600 });
  chmodSync(p, 0o600);
  io.out(`Signed in to ${url} as ${me.name ?? me.userId} (${me.role}).`);
  return 0;
}

interface BotLite {
  id: string;
  name: string;
  status: string;
  description?: string;
  primary: { kind: string; engine?: string; modelId?: string; model?: string };
}

async function findBot(api: OrreryClient, ref: string): Promise<BotLite> {
  const { bots } = await api.get<{ bots: BotLite[] }>("/v1/bots");
  const hit = bots.find((b) => b.id === ref) ?? bots.find((b) => b.name.toLowerCase() === ref.toLowerCase()) ?? bots.filter((b) => b.name.toLowerCase().startsWith(ref.toLowerCase())).at(0);
  if (!hit) throw new UsageError(`no bot "${ref}" (orrery bots)`);
  return hit;
}

const engineOf = (b: BotLite) => (b.primary.kind === "kiro-acp" ? `kiro ${b.primary.engine ?? "v3"}` : b.primary.kind === "opencode-acp" ? "opencode" : b.primary.kind === "openai" ? `openai ${b.primary.model ?? ""}` : b.primary.kind);

async function bots(api: OrreryClient, io: Io, sub: string | undefined, rest: string[], args: Args, json: boolean): Promise<number> {
  if (!sub || sub === "list") {
    const { bots } = await api.get<{ bots: BotLite[] }>("/v1/bots");
    io.out(json ? JSON.stringify(bots, null, 2) : bots.length ? table(bots.map((b) => [b.id, b.name, engineOf(b), b.status]), ["id", "name", "engine", "status"]) : "No bots yet: orrery bots create <name>");
    return 0;
  }
  if (sub === "create") {
    const name = rest.join(" ").trim();
    if (!name) throw new UsageError("orrery bots create <name> [--engine kiro|kiro-v2|opencode|openai] [--model <id>]");
    const engine = String(args.flags.engine ?? "kiro");
    const model = typeof args.flags.model === "string" ? args.flags.model : undefined;
    const primary =
      engine === "opencode"
        ? { kind: "opencode-acp", permissions: "orrery", ...(model ? { modelId: model } : {}) }
        : engine === "openai"
          ? { kind: "openai", providerId: String(args.flags.provider ?? ""), model: model ?? "" }
          : { kind: "kiro-acp", engine: engine === "kiro-v2" ? "v2" : engine === "kiro-auto" ? "auto" : "v3", ...(model ? { modelId: model } : {}) };
    const { bot } = await api.post<{ bot: BotLite }>("/v1/bots", {
      name,
      description: typeof args.flags.description === "string" ? args.flags.description : "",
      instructions: typeof args.flags.instructions === "string" ? args.flags.instructions : "",
      primary,
      ...(typeof args.flags["computer-image"] === "string" ? { computer: { image: args.flags["computer-image"] } } : {}),
    });
    io.out(json ? JSON.stringify(bot, null, 2) : `Created ${bot.name} (${bot.id}, ${engineOf(bot)}). Talk to it: orrery chat ${bot.name}`);
    return 0;
  }
  if (sub === "delete" || sub === "archive") {
    const bot = await findBot(api, rest.join(" "));
    await api.delete(`/v1/bots/${bot.id}`);
    io.out(`Archived ${bot.name}.`);
    return 0;
  }
  throw new UsageError(`unknown: orrery bots ${sub}`);
}

interface GroupLite {
  id: string;
  name: string;
  threadId: string;
  members: Array<{ botId: string; name: string; lead?: boolean }>;
}

async function findGroup(api: OrreryClient, ref: string): Promise<GroupLite | null> {
  const r = await api.get<{ groups: GroupLite[] }>("/v1/groups").catch(() => ({ groups: [] as GroupLite[] }));
  return r.groups.find((g) => g.id === ref || g.threadId === ref) ?? r.groups.find((g) => g.name.toLowerCase() === ref.toLowerCase().replace(/^#/, "")) ?? null;
}

async function groups(api: OrreryClient, io: Io, sub: string | undefined, rest: string[], json: boolean): Promise<number> {
  if (!sub || sub === "list") {
    const { groups } = await api.get<{ groups: GroupLite[] }>("/v1/groups");
    io.out(json ? JSON.stringify(groups, null, 2) : groups.length ? table(groups.map((g) => [g.id, g.name, g.members.map((m) => (m.lead ? `${m.name}*` : m.name)).join(", ")]), ["id", "name", "bots (* leads)"]) : "No groups yet: orrery groups create <name> <bot> <bot>…");
    return 0;
  }
  if (sub === "create") {
    const [name, ...botRefs] = rest;
    if (!name || botRefs.length < 1) throw new UsageError("orrery groups create <name> <bot> <bot>…");
    const ids = [];
    for (const r of botRefs) ids.push((await findBot(api, r)).id);
    const { group } = await api.post<{ group: GroupLite }>("/v1/groups", { name, botIds: ids });
    io.out(json ? JSON.stringify(group, null, 2) : `Created group ${group.name} with ${group.members.map((m) => m.name).join(", ")}. Talk to it: orrery chat ${group.name}`);
    return 0;
  }
  throw new UsageError(`unknown: orrery groups ${sub}`);
}

async function chat(api: OrreryClient, io: Io, cmd: "ask" | "chat", positional: string[], args: Args): Promise<number> {
  const [ref, ...words] = positional;
  if (!ref) throw new UsageError(`orrery ${cmd} <bot|group>${cmd === "ask" ? " <message>" : ""}`);
  const message = (typeof args.flags.message === "string" ? args.flags.message : words.join(" ")).trim() || (cmd === "ask" && !io.isTTY ? (await readStdin(io)).trim() : "");
  if (cmd === "ask" && !message) throw new UsageError("orrery ask <bot> <message> (or pipe the message on stdin)");

  const group = await findGroup(api, ref);
  let threadId = typeof args.flags.thread === "string" ? args.flags.thread : "";
  const botNames = new Map<string, string>();
  let title: string;
  if (group) {
    for (const m of group.members) botNames.set(m.botId, m.name);
    threadId ||= group.threadId;
    title = `#${group.name}`;
  } else {
    const bot = await findBot(api, ref);
    botNames.set(bot.id, bot.name);
    title = bot.name;
    if (!threadId) {
      const { thread } = await api.post<{ thread: { id: string } }>(`/v1/bots/${bot.id}/threads`, { title: message ? message.slice(0, 60) : "Terminal" });
      threadId = thread.id;
    }
  }
  const session = new ChatSession(api, io, { threadId, title, botNames }, { approve: Boolean(args.flags.approve), showThoughts: Boolean(args.flags.thoughts), json: Boolean(args.flags.json) });
  await session.start();
  try {
    if (message) {
      const seconds = Number(args.flags.timeout ?? 0);
      if (!Number.isFinite(seconds) || seconds < 0) throw new UsageError("--timeout takes seconds (0 waits as long as it takes)");
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<"timeout">((resolve) => {
        if (cmd === "ask" && seconds > 0) timer = setTimeout(() => resolve("timeout"), seconds * 1000);
      });
      const ok = await Promise.race([session.send(message), timedOut]).finally(() => clearTimeout(timer));
      if (cmd === "ask") {
        if (ok === "timeout") {
          io.err(style.yellow(`Still running after ${seconds}s. It carries on without you: orrery chat ${ref} --thread ${threadId}`));
          return 124;
        }
        if (!args.flags.json) io.err(style.dim(`thread ${threadId}`));
        return ok ? 0 : 1;
      }
    }
    await session.repl();
    return 0;
  } finally {
    session.stop();
  }
}

async function tokens(api: OrreryClient, io: Io, sub: string | undefined, rest: string[], args: Args, json: boolean): Promise<number> {
  if (!sub || sub === "list") {
    const { tokens } = await api.get<{ tokens: Array<{ id: string; name: string; role: string; userName: string | null; prefix: string; lastUsedAt: string | null; revokedAt: string | null }> }>("/v1/tokens");
    io.out(json ? JSON.stringify(tokens, null, 2) : tokens.length ? table(tokens.map((t) => [t.id, t.name, t.userName ?? "", t.role, `${t.prefix}…`, t.revokedAt ? "revoked" : (t.lastUsedAt ?? "never used")]), ["id", "name", "for", "role", "token", "last used"]) : "No API tokens.");
    return 0;
  }
  if (sub === "create") {
    const name = rest.join(" ").trim();
    if (!name) throw new UsageError("orrery tokens create <name> [--role member] [--for <person>] [--days <n>]");
    const r = await api.post<{ token: string; apiToken: { id: string; role: string } }>("/v1/tokens", {
      name,
      ...(typeof args.flags.role === "string" ? { role: args.flags.role } : {}),
      ...(typeof args.flags.for === "string" ? { forUser: { name: args.flags.for } } : {}),
      ...(typeof args.flags.days === "string" ? { expiresInDays: Number(args.flags.days) } : {}),
    });
    if (json) io.out(JSON.stringify(r, null, 2));
    else {
      io.out(r.token);
      io.err(style.dim(`token ${r.apiToken.id} (${r.apiToken.role}); shown once — store it now`));
    }
    return 0;
  }
  if (sub === "revoke") {
    if (!rest[0]) throw new UsageError("orrery tokens revoke <id>");
    await api.delete(`/v1/tokens/${rest[0]}`);
    io.out(`Revoked ${rest[0]}.`);
    return 0;
  }
  throw new UsageError(`unknown: orrery tokens ${sub}`);
}

async function agentEnv(api: OrreryClient, io: Io, sub: string | undefined, rest: string[], json: boolean): Promise<number> {
  if (!sub || sub === "list") {
    const { variables } = await api.get<{ variables: Array<{ name: string; updatedAt: string }> }>("/v1/agent-env");
    io.out(json ? JSON.stringify(variables, null, 2) : variables.length ? table(variables.map((v) => [v.name, v.updatedAt]), ["name", "updated"]) : "No agent credentials. Set one: orrery env set KIRO_API_KEY");
    return 0;
  }
  if (sub === "set") {
    const [name, ...value] = rest;
    if (!name) throw new UsageError("orrery env set <NAME> [value]");
    const v = value.join(" ") || (await readStdin(io)).trim();
    if (!v) throw new UsageError("empty value");
    await api.put(`/v1/agent-env/${name}`, { value: v });
    io.out(`${name} set. Bot computers pick it up before their next turn.`);
    return 0;
  }
  if (sub === "rm" || sub === "unset" || sub === "delete") {
    if (!rest[0]) throw new UsageError("orrery env rm <NAME>");
    await api.delete(`/v1/agent-env/${rest[0]}`);
    io.out(`${rest[0]} removed.`);
    return 0;
  }
  throw new UsageError(`unknown: orrery env ${sub}`);
}

async function readStdin(io: Io): Promise<string> {
  if (io.isTTY) {
    io.err("value (end with Ctrl+D):");
  }
  const chunks: Buffer[] = [];
  for await (const c of io.stdin) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

export { OrreryClient, ApiError } from "./client.js";
