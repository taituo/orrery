import { randomBytes } from "node:crypto";
import pg from "pg";
import { createPool, migrate, type Db } from "@orrery/db";

/** Create an isolated, migrated database for one test file. */
export async function createTestDb(opts: { vectorDims?: number } = {}): Promise<{ db: Db; url: string; drop(): Promise<void> }> {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) throw new Error("TEST_DATABASE_URL not available (Postgres + pgvector required for this test)");
  const name = `t_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = base.replace(/\/[^/?]+(\?|$)/, `/${name}$1`);
  const db = createPool({ connectionString: url, max: 10 });
  await migrate(db, { vectorDims: opts.vectorDims ?? 64 });
  return {
    db,
    url,
    drop: async () => {
      await db.end();
      const a = new pg.Client({ connectionString: base });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

export const hasTestDb = (): boolean => Boolean(process.env.TEST_DATABASE_URL);
