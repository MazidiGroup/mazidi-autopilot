/**
 * Applies sql/*.sql in filename order, recording each in autopilot._migrations.
 * Postgres-transactional per file: a failed migration leaves nothing half-applied.
 *
 * Deliberately not Prisma: the platform owns public + _prisma_migrations, and a
 * second Prisma workflow on the same database would compete with it. This
 * ledger lives inside the autopilot schema and never touches theirs.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const SQL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "sql");

export async function migrate(pool: pg.Pool): Promise<string[]> {
  const applied: string[] = [];
  const files = (await readdir(SQL_DIR)).filter((f) => f.endsWith(".sql")).sort();

  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS autopilot`);
    await client.query(`CREATE TABLE IF NOT EXISTS autopilot._migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);

    for (const f of files) {
      const name = f.replace(/\.sql$/, "");
      const done = await client.query(`SELECT 1 FROM autopilot._migrations WHERE name=$1`, [name]);
      if (done.rowCount) continue;
      const sql = await readFile(path.join(SQL_DIR, f), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO autopilot._migrations (name) VALUES ($1) ON CONFLICT DO NOTHING`, [name],
        );
        await client.query("COMMIT");
        applied.push(name);
      } catch (e) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${name} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  } finally {
    client.release();
  }
  return applied;
}

if (process.argv[1] && process.argv[1].endsWith("migrate.js")) {
  const url = process.env.AUTOPILOT_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) { console.error("AUTOPILOT_DATABASE_URL / DATABASE_URL not set"); process.exit(1); }
  const pool = new pg.Pool({ connectionString: url });
  migrate(pool)
    .then((a) => { console.log(a.length ? `applied: ${a.join(", ")}` : "nothing to apply"); return pool.end(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
