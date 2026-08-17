#!/usr/bin/env node
/**
 * Postgres integration harness — exercises PgStore against a real, throwaway
 * database: migrations, idempotent task creation, claimDue's locked-subquery
 * claim (limit enforced in SQL, no window functions), reservation arithmetic,
 * and concurrent-claim disjointness.
 *
 * SAFETY: runs ONLY against PG_TEST_URL, and refuses anything that looks like
 * a managed/production host. There is no fallback to DATABASE_URL on purpose.
 *
 *   docker run --rm -e POSTGRES_PASSWORD=t -p 5433:5432 postgres:16
 *   PG_TEST_URL=postgres://postgres:t@localhost:5433/postgres node test/pg-harness.mjs
 */
import pg from "pg";
import { migrate } from "../dist/src/migrate.js";
import { PgStore } from "../dist/src/store-pg.js";

const url = process.env.PG_TEST_URL;
if (!url) {
  console.error("PG_TEST_URL not set — this harness only runs against a throwaway database.");
  process.exit(2);
}
const BANNED = ["supabase.co", "supabase.com", "pooler.", "nibvcqkjtwhqzmrvnbih", "xcbimfmndmvbgociobeh", "amazonaws.com", "azure", "neon.tech"];
const lower = url.toLowerCase();
if (BANNED.some((b) => lower.includes(b))) {
  console.error("PG_TEST_URL points at a managed/production-looking host — refusing.");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: url, max: 10 });
let pass = 0, fail = 0;
const check = (ok, name, detail = "") => {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

// clean slate + the platform table shape we read from
await pool.query(`DROP SCHEMA IF EXISTS autopilot CASCADE`);
await pool.query(`CREATE TABLE IF NOT EXISTS public."OutboxEvent" (
  id text PRIMARY KEY, event text NOT NULL, "companyId" text,
  payload jsonb NOT NULL DEFAULT '{}', "processedAt" timestamptz,
  at timestamptz NOT NULL DEFAULT now(), "externalId" text UNIQUE)`);
await pool.query(`TRUNCATE public."OutboxEvent"`);

console.log("\nMigrations");
const applied = await migrate(pool);
check(applied.includes("001_control_plane"), "001 applied");
check(applied.includes("002_budget_reservations"), "002 applied");
const again = await migrate(pool);
check(again.length === 0, "migrate is idempotent", `re-run applied ${again.length}`);

const store = new PgStore(pool);

console.log("\nTask idempotency");
const t1 = await store.createTask({ type: "research_prospect", payload: { a: 1 }, priority: 7, agentId: "claude-growth", idempotencyKey: "evt:x:research_prospect" });
const t2 = await store.createTask({ type: "research_prospect", payload: { a: 1 }, priority: 7, agentId: "claude-growth", idempotencyKey: "evt:x:research_prospect" });
check(t1.created === true && t2.created === false, "duplicate key returns existing", t2.task.id === t1.task.id ? "same id" : "DIFFERENT ID");
check(t2.task.id === t1.task.id, "same task id on replay");

console.log("\nclaimDue — SQL-level limit, no window functions");
for (let i = 0; i < 5; i++) {
  await store.createTask({ type: "research_prospect", payload: { i }, priority: 5, agentId: "claude-growth", idempotencyKey: `bulk:${i}` });
}
const claimed = await store.claimDue(["claude-growth"], 3);
check(claimed.length === 3, "claims exactly the limit", `got ${claimed.length}`);
const { rows: [{ running }] } = await pool.query(`SELECT count(*)::int AS running FROM autopilot.task WHERE status='running'`);
check(running === 3, "ONLY the claimed rows are running", `running=${running}`);
const { rows: [{ ready }] } = await pool.query(`SELECT count(*)::int AS ready FROM autopilot.task WHERE status='ready'`);
check(ready === 3, "unclaimed rows remain ready", `ready=${ready}`);

console.log("\nConcurrent claim disjointness");
// two claimers race for the remaining 3 ready tasks
const [c1, c2] = await Promise.all([store.claimDue(["claude-growth"], 10), store.claimDue(["claude-growth"], 10)]);
const ids1 = new Set(c1.map((t) => t.id));
const overlap = c2.filter((t) => ids1.has(t.id));
check(overlap.length === 0, "no task claimed by both", `overlap=${overlap.length}`);
check(c1.length + c2.length === 3, "every ready task claimed exactly once", `${c1.length}+${c2.length}`);

console.log("\nConcurrency cap");
await pool.query(`UPDATE autopilot.agent SET max_concurrency = 2 WHERE id='gpt-strategist'`);
for (let i = 0; i < 4; i++) {
  await store.createTask({ type: "update_growth_metrics", payload: { i }, priority: 5, agentId: "gpt-strategist", idempotencyKey: `s:${i}` });
}
const sClaim = await store.claimDue(["gpt-strategist"], 10);
// simulate 2 in-flight runs
for (const t of sClaim.slice(0, 2)) await store.startRun(t.id, "gpt-strategist");
check(sClaim.length === 2, "cap limits the claim", `claimed=${sClaim.length}`);
const sClaim2 = await store.claimDue(["gpt-strategist"], 10);
check(sClaim2.length === 0, "at capacity claims nothing", `claimed=${sClaim2.length}`);

console.log("\nBudget reservation atomicity");
await pool.query(`INSERT INTO autopilot.budget (id, period, limit_gbp) VALUES ('b','daily',1.00)
                  ON CONFLICT (id) DO UPDATE SET limit_gbp=1.00, spent_gbp=0, reserved_gbp=0`);
const results = await Promise.all(Array.from({ length: 5 }, () => store.reserve("b", 0.4)));
const granted = results.filter(Boolean).length;
check(granted === 2, "concurrent reservations cannot jointly overspend", `granted ${granted}/5 at £0.40 against £1.00`);
await store.settleSpend("b", 0.4, 0.1);
const b = await store.getBudget("b");
check(Math.abs(b.reservedGbp - 0.4) < 1e-9 && Math.abs(b.spentGbp - 0.1) < 1e-9,
  "settle releases one reservation and records actual", `reserved=${b.reservedGbp} spent=${b.spentGbp}`);
const atCeiling = await store.reserve("b", 0.51); // 0.1 + 0.4 + 0.51 > 1.00
check(atCeiling === false, "reservation respects remaining headroom");
const exact = await store.reserve("b", 0.5);      // 0.1 + 0.4 + 0.5 = 1.00 exactly
check(exact === true, "sum equal to limit is admitted (ceiling, not trigger)");
const none = await store.reserve("b", 0.01);
check(none === false, "budget exactly at ceiling admits nothing further");

console.log("\nRetry/backoff");
const rt = await store.createTask({ type: "research_prospect", payload: {}, priority: 5, agentId: "claude-growth", idempotencyKey: "retry:1" });
const afterFail = await store.failTask(rt.task.id, { retryInMs: 60000 });
check(afterFail.status === "ready" && afterFail.attempts === 1, "first failure retries", afterFail.status);
check(afterFail.runAfter.getTime() > Date.now(), "backoff scheduled in the future");
await store.failTask(rt.task.id, { retryInMs: 60000 });
const terminal = await store.failTask(rt.task.id, { retryInMs: 60000 });
check(terminal.status === "failed" && terminal.attempts === 3, "terminal at max attempts", `${terminal.status}@${terminal.attempts}`);

await pool.end();
console.log(`\n${fail === 0 ? "PG INTEGRATION GREEN" : `${fail} FAILURE(S)`} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
