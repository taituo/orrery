import { loadEnv } from "@orrery/core";
import { createPool, migrate } from "./pool.js";

/** `orrery-db migrate` — run as a Helm pre-upgrade hook Job and in local dev. */
const cmd = process.argv[2] ?? "migrate";
const env = loadEnv();
const db = createPool({ connectionString: env.DATABASE_URL, ssl: env.DATABASE_SSL, max: 2, applicationName: "orrery-migrate" });

try {
  if (cmd !== "migrate") throw new Error(`unknown command ${cmd}`);
  const applied = await migrate(db, { log: (m) => console.log(m) });
  console.log(applied.length ? `applied ${applied.length} migration(s)` : "schema up to date");
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await db.end();
}
