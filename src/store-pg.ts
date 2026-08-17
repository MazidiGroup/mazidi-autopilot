/**
 * Postgres Store against mazidi-prod.
 *
 * Owns the "autopilot" schema only. The single read outside it is
 * public."OutboxEvent", cursor-paged and never written: the platform's rules
 * engine owns processedAt, and this consumer group must never race it.
 *
 * NOT exercised by the test suite (no Postgres in the authoring sandbox) —
 * kept deliberately thin so that everything with behaviour lives in
 * heartbeat/policy/router, which are tested. Semantics this adapter must
 * uphold (idempotent create via ON CONFLICT, exactly-once claim via
 * conditional UPDATE) were proven against real Postgres execution in
 * Autopilot/backbone-semantics-proof.mjs.
 */
import pg from "pg";
import type { Store } from "./store.js";
import type { Agent, Approval, Budget, OutboxEvent, Run, Task } from "./types.js";

const T = (r: Record<string, unknown>): Task => ({
  id: r["id"] as string,
  type: r["type"] as string,
  payload: (r["payload"] ?? {}) as Record<string, unknown>,
  priority: r["priority"] as number,
  status: r["status"] as Task["status"],
  agentId: (r["agent_id"] ?? null) as string | null,
  idempotencyKey: (r["idempotency_key"] ?? null) as string | null,
  attempts: r["attempts"] as number,
  maxAttempts: r["max_attempts"] as number,
  runAfter: r["run_after"] as Date,
  estimatedCostGbp: r["estimated_cost_gbp"] === null || r["estimated_cost_gbp"] === undefined
    ? null : Number(r["estimated_cost_gbp"]),
});

export class PgStore implements Store {
  constructor(private readonly pool: pg.Pool) {}

  static fromEnv(): PgStore {
    const url = process.env.AUTOPILOT_DATABASE_URL ?? process.env.DATABASE_URL;
    if (!url) throw new Error("AUTOPILOT_DATABASE_URL / DATABASE_URL not set");
    return new PgStore(new pg.Pool({ connectionString: url, max: 5 }));
  }

  private async q(text: string, values: unknown[] = []): Promise<Record<string, unknown>[]> {
    const r = await this.pool.query(text, values);
    return r.rows as Record<string, unknown>[];
  }

  async listAgents(): Promise<Agent[]> {
    const rows = await this.q(`SELECT id, role, enabled, max_concurrency FROM autopilot.agent WHERE enabled`);
    return rows.map((r) => ({
      id: r["id"] as string, role: r["role"] as string,
      enabled: r["enabled"] as boolean, maxConcurrency: r["max_concurrency"] as number,
    }));
  }

  async createTask(spec: {
    type: string; payload: Record<string, unknown>; priority: number;
    agentId: string | null; idempotencyKey: string | null; maxAttempts?: number;
  }): Promise<{ task: Task; created: boolean }> {
    if (spec.idempotencyKey) {
      const inserted = await this.q(
        `INSERT INTO autopilot.task (type, payload, priority, agent_id, idempotency_key, max_attempts)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING *`,
        [spec.type, spec.payload, spec.priority, spec.agentId, spec.idempotencyKey, spec.maxAttempts ?? 3],
      );
      const first = inserted[0];
      if (first) return { task: T(first), created: true };
      const existing = await this.q(
        `SELECT * FROM autopilot.task WHERE idempotency_key = $1`, [spec.idempotencyKey],
      );
      return { task: T(existing[0]!), created: false };
    }
    const rows = await this.q(
      `INSERT INTO autopilot.task (type, payload, priority, agent_id, max_attempts)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [spec.type, spec.payload, spec.priority, spec.agentId, spec.maxAttempts ?? 3],
    );
    return { task: T(rows[0]!), created: true };
  }

  async claimDue(agentIds: string[], limit: number): Promise<Task[]> {
    // One locked-subquery claim per agent. The inner SELECT takes row locks
    // with FOR UPDATE SKIP LOCKED (no window functions — Postgres rejects
    // FOR UPDATE in a query level that has them), the LIMIT is enforced in
    // SQL before anything is marked running, and the outer UPDATE re-checks
    // status='ready' so a row that changed between lock and update is left
    // alone. Concurrent heartbeats claim disjoint rows via SKIP LOCKED.
    //
    // Per-agent free capacity is computed first from running runs; an agent
    // at capacity claims LIMIT 0, i.e. nothing.
    const agents = await this.listAgents();
    const running = await this.runningCountByAgent();

    const claimed: Task[] = [];
    let remaining = limit;
    for (const agent of agents) {
      if (remaining <= 0) break;
      if (!agentIds.includes(agent.id)) continue;
      const free = Math.min(
        remaining,
        Math.max(0, agent.maxConcurrency - (running.get(agent.id) ?? 0)),
      );
      if (free <= 0) continue;
      const rows = await this.q(
        `UPDATE autopilot.task t
         SET status = 'running', updated_at = now()
         FROM (
           SELECT id FROM autopilot.task
           WHERE status = 'ready' AND run_after <= now() AND agent_id = $1
           ORDER BY priority DESC, created_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         ) picked
         WHERE t.id = picked.id AND t.status = 'ready'
         RETURNING t.*`,
        [agent.id, free],
      );
      for (const r of rows) claimed.push(T(r));
      remaining -= rows.length;
    }
    return claimed;
  }

  async completeTask(taskId: string): Promise<void> {
    await this.q(`UPDATE autopilot.task SET status='completed', updated_at=now() WHERE id=$1`, [taskId]);
  }

  async failTask(taskId: string, opts: { retryInMs: number | null }): Promise<Task> {
    const rows = await this.q(
      `UPDATE autopilot.task
       SET attempts = attempts + 1,
           status = CASE WHEN $2::bigint IS NOT NULL AND attempts + 1 < max_attempts THEN 'ready' ELSE 'failed' END,
           run_after = CASE WHEN $2::bigint IS NOT NULL THEN now() + ($2::bigint || ' milliseconds')::interval ELSE run_after END,
           updated_at = now()
       WHERE id = $1 RETURNING *`,
      [taskId, opts.retryInMs],
    );
    return T(rows[0]!);
  }

  async blockForBudget(taskId: string, estimatedCostGbp: number | null): Promise<void> {
    await this.q(
      `UPDATE autopilot.task SET status='budget_blocked', estimated_cost_gbp=$2, updated_at=now() WHERE id=$1`,
      [taskId, estimatedCostGbp],
    );
  }

  async listBudgetBlocked(agentIds: string[], limit: number): Promise<Task[]> {
    const rows = await this.q(
      `SELECT * FROM autopilot.task
       WHERE status='budget_blocked' AND agent_id = ANY($1)
       ORDER BY created_at LIMIT $2`,
      [agentIds, limit],
    );
    return rows.map(T);
  }

  async unblock(taskId: string): Promise<void> {
    await this.q(
      `UPDATE autopilot.task SET status='ready', updated_at=now()
       WHERE id=$1 AND status='budget_blocked'`,
      [taskId],
    );
  }

  async holdForApproval(taskId: string): Promise<void> {
    await this.q(`UPDATE autopilot.task SET status='awaiting_approval', updated_at=now() WHERE id=$1`, [taskId]);
  }

  async startRun(taskId: string, agentId: string): Promise<Run> {
    const rows = await this.q(
      `INSERT INTO autopilot.run (task_id, agent_id) VALUES ($1,$2) RETURNING *`, [taskId, agentId],
    );
    const r = rows[0]!;
    return {
      id: r["id"] as string, taskId, agentId, status: "running",
      outcome: null, error: null, costGbp: 0, tokens: 0,
    };
  }

  async finishRun(runId: string, r: {
    status: "succeeded" | "failed"; outcome?: Record<string, unknown>;
    error?: string; costGbp?: number; tokens?: number;
  }): Promise<void> {
    await this.q(
      `UPDATE autopilot.run
       SET status=$2, outcome=$3, error=$4, cost_gbp=$5, tokens=$6, finished_at=now()
       WHERE id=$1`,
      [runId, r.status, r.outcome ?? null, r.error ?? null, r.costGbp ?? 0, r.tokens ?? 0],
    );
  }

  async runningCountByAgent(): Promise<Map<string, number>> {
    const rows = await this.q(
      `SELECT agent_id, COUNT(*)::int AS c FROM autopilot.run WHERE status='running' GROUP BY agent_id`,
    );
    return new Map(rows.map((r) => [r["agent_id"] as string, r["c"] as number]));
  }

  async createApproval(a: { action: string; payload: Record<string, unknown>; reason: string; requestedBy: string }): Promise<Approval> {
    const rows = await this.q(
      `INSERT INTO autopilot.approval (action, payload, reason, requested_by)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [a.action, a.payload, a.reason, a.requestedBy],
    );
    return { id: rows[0]!["id"] as string, status: "pending", ...a };
  }

  async audit(actor: string, action: string, entity?: string, entityId?: string, detail?: Record<string, unknown>): Promise<void> {
    await this.q(
      `INSERT INTO autopilot.audit (actor, action, entity, entity_id, detail) VALUES ($1,$2,$3,$4,$5)`,
      [actor, action, entity ?? null, entityId ?? null, detail ?? null],
    );
  }

  async getBudget(id: string): Promise<Budget | null> {
    const rows = await this.q(`SELECT * FROM autopilot.budget WHERE id=$1`, [id]);
    const r = rows[0];
    if (!r) return null;
    return {
      id: r["id"] as string, period: r["period"] as Budget["period"],
      limitGbp: Number(r["limit_gbp"]), spentGbp: Number(r["spent_gbp"]),
      reservedGbp: Number(r["reserved_gbp"] ?? 0),
    };
  }

  async reserve(budgetId: string, gbp: number): Promise<boolean> {
    // Check-and-reserve in ONE statement: the WHERE clause is the guard, so
    // two concurrent reservations serialise on the row and the second sees
    // the first's reservation. Strict inequality via <=: a budget exactly at
    // its ceiling admits nothing further.
    const rows = await this.q(
      `UPDATE autopilot.budget
       SET reserved_gbp = reserved_gbp + $2
       WHERE id = $1 AND spent_gbp + reserved_gbp + $2 <= limit_gbp
       RETURNING id`,
      [budgetId, gbp],
    );
    return rows.length === 1;
  }

  async settleSpend(budgetId: string, reservedGbp: number, actualGbp: number): Promise<void> {
    await this.q(
      `UPDATE autopilot.budget
       SET reserved_gbp = GREATEST(0, reserved_gbp - $2),
           spent_gbp = spent_gbp + $3
       WHERE id = $1`,
      [budgetId, reservedGbp, actualGbp],
    );
  }

  async addSpend(budgetId: string, gbp: number): Promise<void> {
    await this.q(`UPDATE autopilot.budget SET spent_gbp = spent_gbp + $2 WHERE id=$1`, [budgetId, gbp]);
  }

  async readOutboxAfter(cursor: { lastAt: Date; lastId: string }, limit: number): Promise<OutboxEvent[]> {
    const rows = await this.q(
      `SELECT id, event, "companyId", payload, at
       FROM public."OutboxEvent"
       WHERE (at, id) > ($1, $2)
       ORDER BY at ASC, id ASC
       LIMIT $3`,
      [cursor.lastAt, cursor.lastId, limit],
    );
    return rows.map((r) => ({
      id: r["id"] as string, event: r["event"] as string,
      companyId: (r["companyId"] ?? null) as string | null,
      payload: (r["payload"] ?? {}) as Record<string, unknown>,
      at: r["at"] as Date,
    }));
  }

  async getCursor(): Promise<{ lastAt: Date; lastId: string }> {
    const rows = await this.q(`SELECT last_at, last_id FROM autopilot.outbox_cursor WHERE id='main'`);
    const r = rows[0];
    return r
      ? { lastAt: r["last_at"] as Date, lastId: r["last_id"] as string }
      : { lastAt: new Date(0), lastId: "" };
  }

  async setCursor(c: { lastAt: Date; lastId: string }): Promise<void> {
    await this.q(
      `INSERT INTO autopilot.outbox_cursor (id, last_at, last_id) VALUES ('main',$1,$2)
       ON CONFLICT (id) DO UPDATE SET last_at=$1, last_id=$2`,
      [c.lastAt, c.lastId],
    );
  }
}
