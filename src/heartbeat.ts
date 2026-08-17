/**
 * The heartbeat — Workflow 006 made real. Deterministic software that invokes
 * AI only where judgment is needed, in five steps:
 *
 *   1. ingest   read new OutboxEvent rows via our own cursor (never claiming —
 *               the platform rules engine owns processedAt) and map them to
 *               tasks, idempotently
 *   2. gate     consult policy per task; gated work becomes an approval row,
 *               not an action
 *   3. claim    claim due tasks for agents whose adapters are configured,
 *               respecting per-agent concurrency
 *   4. execute  run the agent, record the run and its cost
 *   5. settle   completed / retry-with-backoff / failed, budgets updated
 *
 * Every step is replay-safe: cursor + idempotency keys mean running the
 * heartbeat twice does exactly what running it once does.
 */
import type { AgentAdapter } from "./agents.js";
import { DEFAULT_ESTIMATES, estimateCost, type EstimateTable } from "./estimates.js";
import { decide, DEFAULT_CONFIG, type PolicyConfig } from "./policy.js";
import { agentForTask, tasksForEvent } from "./router.js";
import type { Store } from "./store.js";

export interface HeartbeatOptions {
  batch?: number;
  policy?: PolicyConfig;
  /** Budget drawn on by agent spend. Required for any paid work to run. */
  spendBudgetId?: string;
  /** Backoff base in ms; attempt n waits base * 2^(n-1). */
  backoffBaseMs?: number;
  /** Cost estimates by task/agent. Configuration, not code. */
  estimates?: EstimateTable;
}

export interface HeartbeatSummary {
  eventsIngested: number;
  tasksCreated: number;
  tasksGated: number;
  tasksBudgetBlocked: number;
  tasksUnblocked: number;
  tasksClaimed: number;
  runsSucceeded: number;
  runsFailed: number;
  spendGbp: number;
}

export async function heartbeat(
  store: Store,
  adapters: AgentAdapter[],
  opts: HeartbeatOptions = {},
): Promise<HeartbeatSummary> {
  const batch = opts.batch ?? 25;
  const policy = opts.policy ?? DEFAULT_CONFIG;
  const backoffBase = opts.backoffBaseMs ?? 60_000;
  const estimates = opts.estimates ?? DEFAULT_ESTIMATES;
  const summary: HeartbeatSummary = {
    eventsIngested: 0, tasksCreated: 0, tasksGated: 0,
    tasksBudgetBlocked: 0, tasksUnblocked: 0,
    tasksClaimed: 0, runsSucceeded: 0, runsFailed: 0, spendGbp: 0,
  };

  // ── 1. ingest ──────────────────────────────────────────
  const cursor = await store.getCursor();
  const events = await store.readOutboxAfter(cursor, batch);
  for (const ev of events) {
    summary.eventsIngested++;
    for (const spec of tasksForEvent(ev)) {
      const agentId = agentForTask(spec.type);
      if (agentId === null) {
        await store.audit("heartbeat", "task.unroutable", "outbox_event", ev.id, { type: spec.type });
        continue;
      }
      // Key includes the task type: one event may fan out to several tasks,
      // each individually replay-safe.
      const { created, task } = await store.createTask({
        ...spec, agentId, idempotencyKey: `evt:${ev.id}:${spec.type}`,
      });
      if (created) {
        summary.tasksCreated++;
        await store.audit("heartbeat", "task.created", "task", task.id, { from: ev.event });

        // ── 2. gate ────────────────────────────────────
        const budget = opts.spendBudgetId ? await store.getBudget(opts.spendBudgetId) : null;
        const d = decide({ action: task.type, budget: budget ?? undefined }, policy);
        if (d.verdict === "require_approval") {
          await store.holdForApproval(task.id);
          await store.createApproval({
            action: task.type, payload: task.payload, reason: d.reason, requestedBy: "heartbeat",
          });
          await store.audit("policy", "task.gated", "task", task.id, { reason: d.reason });
          summary.tasksGated++;
        }
      }
    }
    await store.setCursor({ lastAt: ev.at, lastId: ev.id });
  }

  // ── 3a. unblock ────────────────────────────────────────
  // budget_blocked work re-enters ready when headroom exists again. Checked
  // against the budget read-only here; the authoritative reservation still
  // happens at execution time, so this can never over-admit.
  const configured = adapters.filter((a) => a.isConfigured());
  const byId = new Map(configured.map((a) => [a.agentId, a]));
  const claimable = configured.map((a) => a.agentId);
  if (claimable.length && opts.spendBudgetId) {
    const budget = await store.getBudget(opts.spendBudgetId);
    if (budget) {
      const headroom = budget.limitGbp - budget.spentGbp - budget.reservedGbp;
      for (const t of await store.listBudgetBlocked(claimable, batch)) {
        const est = estimateCost(t.type, t.agentId!, estimates);
        if (est !== null && est <= headroom + 1e-9) {
          await store.unblock(t.id);
          await store.audit("heartbeat", "task.unblocked", "task", t.id, { estimate: est });
          summary.tasksUnblocked++;
        }
      }
    }
  }

  // ── 3b. claim ──────────────────────────────────────────
  const tasks = claimable.length ? await store.claimDue(claimable, batch) : [];
  summary.tasksClaimed = tasks.length;

  // ── 4 + 5. execute and settle ──────────────────────────
  for (const task of tasks) {
    const adapter = byId.get(task.agentId!);
    if (!adapter) continue; // cannot happen; claimDue filters — belt and braces

    // ── budget reservation, before any execution ─────────
    const estimate = estimateCost(task.type, task.agentId!, estimates);

    if (estimate === null) {
      // A paid agent with no estimate fails CLOSED. "We forgot to price this"
      // must never mean "it runs for free". Parks visibly, burns no attempt.
      await store.blockForBudget(task.id, null);
      await store.audit("policy", "task.budget_blocked", "task", task.id,
        { reason: "no cost estimate for paid agent" });
      summary.tasksBudgetBlocked++;
      continue;
    }

    let reserved = 0;
    if (estimate > 0) {
      if (!opts.spendBudgetId) {
        await store.blockForBudget(task.id, estimate);
        await store.audit("policy", "task.budget_blocked", "task", task.id,
          { reason: "paid work with no budget configured", estimate });
        summary.tasksBudgetBlocked++;
        continue;
      }
      const ok = await store.reserve(opts.spendBudgetId, estimate);
      if (!ok) {
        await store.blockForBudget(task.id, estimate);
        await store.audit("policy", "task.budget_blocked", "task", task.id,
          { reason: "budget cannot admit estimate", estimate });
        summary.tasksBudgetBlocked++;
        continue;
      }
      reserved = estimate;
    }
    // estimate === 0: deterministic work runs even at a budget ceiling.

    const run = await store.startRun(task.id, task.agentId!);
    try {
      const result = await adapter.execute(task.type, task.payload);
      await store.finishRun(run.id, {
        status: "succeeded", outcome: result.outcome,
        costGbp: result.costGbp, tokens: result.tokens,
      });
      if (opts.spendBudgetId && (reserved > 0 || result.costGbp > 0)) {
        await store.settleSpend(opts.spendBudgetId, reserved, result.costGbp);
        if (result.costGbp > reserved) {
          // Overage is recorded loudly; the budget arithmetic already blocks
          // subsequent work until headroom returns or the limit is raised.
          await store.audit("policy", "budget.overage", "task", task.id, {
            estimate: reserved, actual: result.costGbp,
            overage: Math.round((result.costGbp - reserved) * 100) / 100,
          });
        }
      }
      summary.spendGbp += result.costGbp;
      await store.completeTask(task.id);
      await store.audit(task.agentId!, "task.completed", "task", task.id, { runId: run.id });
      summary.runsSucceeded++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await store.finishRun(run.id, { status: "failed", error: message });
      if (opts.spendBudgetId && reserved > 0) {
        // Failed runs release their reservation; any real cost incurred before
        // the failure is still recorded as spend.
        await store.settleSpend(opts.spendBudgetId, reserved, 0);
      }
      const after = await store.failTask(task.id, {
        retryInMs: backoffBase * 2 ** task.attempts,
      });
      await store.audit(task.agentId!, "task.retry_or_fail", "task", task.id, {
        runId: run.id, error: message, attempts: after.attempts, status: after.status,
      });
      summary.runsFailed++;
    }
  }

  return summary;
}
