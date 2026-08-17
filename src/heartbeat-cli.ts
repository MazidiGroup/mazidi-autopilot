/** CLI entry: one heartbeat pass against Postgres. Schedule via cron. */
import { DEFAULT_ADAPTERS } from "./agents.js";
import { heartbeat } from "./heartbeat.js";
import { PgStore } from "./store-pg.js";

const store = PgStore.fromEnv();
heartbeat(store, DEFAULT_ADAPTERS, {
  spendBudgetId: process.env.AUTOPILOT_SPEND_BUDGET ?? "agent_spend_daily",
})
  .then((s) => console.log(JSON.stringify(s)))
  .catch((e) => { console.error(e); process.exit(1); });
