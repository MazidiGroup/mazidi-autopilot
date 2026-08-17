/**
 * In-memory Store. Backs the test suite; also useful for dry-running the
 * heartbeat without a database. Implements the same semantics PgStore must:
 * idempotent creation, exactly-once claim, ordered cursor reads.
 */
import { randomUUID } from "node:crypto";
import type { Store } from "./store.js";
import type { Agent, Approval, Budget, OutboxEvent, Run, Task } from "./types.js";

export class MemStore implements Store {
  agents: Agent[] = [];
  tasks = new Map<string, Task>();
  runs = new Map<string, Run>();
  approvals: Approval[] = [];
  auditLog: Array<{ actor: string; action: string; entity?: string; entityId?: string; detail?: unknown }> = [];
  budgets = new Map<string, Budget>();
  outbox: OutboxEvent[] = [];
  private cursor = { lastAt: new Date(0), lastId: "" };
  private byKey = new Map<string, string>();

  async listAgents() { return this.agents.filter((a) => a.enabled); }

  async createTask(spec: {
    type: string; payload: Record<string, unknown>; priority: number;
    agentId: string | null; idempotencyKey: string | null; maxAttempts?: number;
  }): Promise<{ task: Task; created: boolean }> {
    if (spec.idempotencyKey) {
      const existing = this.byKey.get(spec.idempotencyKey);
      if (existing) return { task: this.tasks.get(existing)!, created: false };
    }
    const task: Task = {
      id: randomUUID(), type: spec.type, payload: spec.payload, priority: spec.priority,
      status: "ready", agentId: spec.agentId, idempotencyKey: spec.idempotencyKey,
      attempts: 0, maxAttempts: spec.maxAttempts ?? 3, runAfter: new Date(0),
      estimatedCostGbp: null,
    };
    this.tasks.set(task.id, task);
    if (spec.idempotencyKey) this.byKey.set(spec.idempotencyKey, task.id);
    return { task, created: true };
  }

  async claimDue(agentIds: string[], limit: number): Promise<Task[]> {
    const now = Date.now();
    const running = await this.runningCountByAgent();
    const capacity = new Map<string, number>();
    for (const a of this.agents) {
      capacity.set(a.id, Math.max(0, a.maxConcurrency - (running.get(a.id) ?? 0)));
    }
    const due = [...this.tasks.values()]
      .filter((t) => t.status === "ready" && t.runAfter.getTime() <= now
        && t.agentId !== null && agentIds.includes(t.agentId))
      .sort((a, b) => b.priority - a.priority);

    const claimed: Task[] = [];
    for (const t of due) {
      if (claimed.length >= limit) break;
      const cap = capacity.get(t.agentId!) ?? 0;
      if (cap <= 0) continue;
      // exactly-once: status flips ready->running atomically in this map
      if (t.status !== "ready") continue;
      t.status = "running";
      capacity.set(t.agentId!, cap - 1);
      claimed.push(t);
    }
    return claimed;
  }

  async completeTask(taskId: string) {
    const t = this.tasks.get(taskId); if (!t) return;
    t.status = "completed";
  }

  async failTask(taskId: string, opts: { retryInMs: number | null }): Promise<Task> {
    const t = this.tasks.get(taskId);
    if (!t) throw new Error(`no task ${taskId}`);
    t.attempts += 1;
    if (opts.retryInMs !== null && t.attempts < t.maxAttempts) {
      t.status = "ready";
      t.runAfter = new Date(Date.now() + opts.retryInMs);
    } else {
      t.status = "failed";
    }
    return t;
  }

  async blockForBudget(taskId: string, estimatedCostGbp: number | null) {
    const t = this.tasks.get(taskId); if (!t) return;
    t.status = "budget_blocked";
    t.estimatedCostGbp = estimatedCostGbp;
  }

  async listBudgetBlocked(agentIds: string[], limit: number) {
    return [...this.tasks.values()]
      .filter((t) => t.status === "budget_blocked" && t.agentId !== null && agentIds.includes(t.agentId))
      .slice(0, limit);
  }

  async unblock(taskId: string) {
    const t = this.tasks.get(taskId); if (!t) return;
    if (t.status === "budget_blocked") t.status = "ready";
  }

  async holdForApproval(taskId: string) {
    const t = this.tasks.get(taskId); if (!t) return;
    t.status = "awaiting_approval";
  }

  async startRun(taskId: string, agentId: string): Promise<Run> {
    const run: Run = {
      id: randomUUID(), taskId, agentId, status: "running",
      outcome: null, error: null, costGbp: 0, tokens: 0,
    };
    this.runs.set(run.id, run);
    return run;
  }

  async finishRun(runId: string, r: {
    status: "succeeded" | "failed"; outcome?: Record<string, unknown>;
    error?: string; costGbp?: number; tokens?: number;
  }) {
    const run = this.runs.get(runId); if (!run) return;
    run.status = r.status;
    run.outcome = r.outcome ?? null;
    run.error = r.error ?? null;
    run.costGbp = r.costGbp ?? 0;
    run.tokens = r.tokens ?? 0;
  }

  async runningCountByAgent(): Promise<Map<string, number>> {
    const m = new Map<string, number>();
    for (const r of this.runs.values()) {
      if (r.status === "running") m.set(r.agentId, (m.get(r.agentId) ?? 0) + 1);
    }
    return m;
  }

  async createApproval(a: { action: string; payload: Record<string, unknown>; reason: string; requestedBy: string }): Promise<Approval> {
    const row: Approval = { id: randomUUID(), status: "pending", ...a };
    this.approvals.push(row);
    return row;
  }

  async audit(actor: string, action: string, entity?: string, entityId?: string, detail?: Record<string, unknown>) {
    this.auditLog.push({ actor, action, ...(entity !== undefined && { entity }), ...(entityId !== undefined && { entityId }), ...(detail !== undefined && { detail }) });
  }

  async getBudget(id: string) { return this.budgets.get(id) ?? null; }

  async reserve(budgetId: string, gbp: number): Promise<boolean> {
    const b = this.budgets.get(budgetId);
    if (!b) return false; // no budget configured for paid work = fail closed
    // strict >: a budget exactly at its ceiling admits no further paid work
    if (b.spentGbp + b.reservedGbp + gbp > b.limitGbp + 1e-9) return false;
    b.reservedGbp = Math.round((b.reservedGbp + gbp) * 100) / 100;
    return true;
  }

  async settleSpend(budgetId: string, reservedGbp: number, actualGbp: number) {
    const b = this.budgets.get(budgetId); if (!b) return;
    b.reservedGbp = Math.max(0, Math.round((b.reservedGbp - reservedGbp) * 100) / 100);
    b.spentGbp = Math.round((b.spentGbp + actualGbp) * 100) / 100;
  }

  async addSpend(budgetId: string, gbp: number) {
    const b = this.budgets.get(budgetId);
    if (b) b.spentGbp = Math.round((b.spentGbp + gbp) * 100) / 100;
  }

  async readOutboxAfter(cursor: { lastAt: Date; lastId: string }, limit: number): Promise<OutboxEvent[]> {
    return this.outbox
      .filter((e) =>
        e.at.getTime() > cursor.lastAt.getTime() ||
        (e.at.getTime() === cursor.lastAt.getTime() && e.id > cursor.lastId))
      .sort((a, b) => a.at.getTime() - b.at.getTime() || (a.id < b.id ? -1 : 1))
      .slice(0, limit);
  }

  async getCursor() { return { ...this.cursor }; }
  async setCursor(c: { lastAt: Date; lastId: string }) { this.cursor = { ...c }; }
}
