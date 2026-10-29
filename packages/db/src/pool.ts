import pg from "pg";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export type Db = pg.Pool;
export type Queryable = pg.Pool | pg.PoolClient;

export interface DbOptions {
  connectionString: string;
  max?: number;
  ssl?: boolean;
  applicationName?: string;
}

export function createPool(opts: DbOptions): Db {
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: opts.applicationName ?? "orrery",
    ...(opts.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
  });
  pool.on("error", () => {
    /* idle client errors are retried by the pool; never crash the process */
  });
  return pool;
}

export async function withTx<T>(db: Db, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------ migrations */

export function migrationsDir(): string {
  const env = process.env.ORRERY_MIGRATIONS_DIR;
  if (env) return env;
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/pool.ts → ../migrations ; bundled dist/main.js → ./migrations
  for (const candidate of [path.join(here, "../migrations"), path.join(here, "migrations")]) {
    try {
      readdirSync(candidate);
      return candidate;
    } catch {
      /* try next */
    }
  }
  throw new Error("migrations directory not found (set ORRERY_MIGRATIONS_DIR)");
}

export interface MigrateOptions {
  vectorDims?: number;
  dir?: string;
  log?: (msg: string) => void;
}

const LOCK_KEY = 4_242_013;

/** Apply pending SQL migrations in order, under an advisory lock (safe with N replicas). */
export async function migrate(db: Db, opts: MigrateOptions = {}): Promise<string[]> {
  const dims = opts.vectorDims ?? Number(process.env.ORRERY_VECTOR_DIMS ?? 1536);
  if (!Number.isInteger(dims) || dims < 8 || dims > 2000) throw new Error(`invalid vector dims ${dims} (HNSW supports up to 2000)`);
  const dir = opts.dir ?? migrationsDir();
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const client = await db.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), vector_dims integer)");
    const done = new Set((await client.query<{ version: string }>("SELECT version FROM schema_migrations")).rows.map((r) => r.version));
    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      if (done.has(version)) continue;
      const sql = readFileSync(path.join(dir, file), "utf8").replaceAll("{{VECTOR_DIMS}}", String(dims));
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version, vector_dims) VALUES ($1, $2)", [version, dims]);
        await client.query("COMMIT");
        applied.push(version);
        opts.log?.(`applied migration ${version}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${version} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
  return applied;
}

export async function vectorDims(db: Queryable): Promise<number> {
  const r = await db.query<{ vector_dims: number | null }>("SELECT vector_dims FROM schema_migrations WHERE vector_dims IS NOT NULL ORDER BY version LIMIT 1");
  return r.rows[0]?.vector_dims ?? 1536;
}

/** pgvector literal, zero-padded to the column width (cosine similarity is unchanged). */
export function toVector(v: readonly number[], dims: number): string {
  if (v.length > dims) throw new Error(`embedding has ${v.length} dims; column holds ${dims} (raise ORRERY_VECTOR_DIMS)`);
  const parts = new Array<string>(dims);
  for (let i = 0; i < dims; i++) {
    const x = i < v.length ? v[i]! : 0;
    parts[i] = Number.isFinite(x) ? String(x) : "0";
  }
  return `[${parts.join(",")}]`;
}
