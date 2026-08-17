/**
 * Storage boundary. The heartbeat's logic is what needs proving; SQL is a thin
 * adapter behind this interface. MemStore backs the tests, PgStore backs
 * production — both must satisfy the same semantics, and the semantics that
 * matter (idempotent creation, exactly-once claim) are asserted in the test
 * suite against this interface.
 */
import type { Agent, Approval, Budget, OutboxEvent, Run, Task } from "./types.js";

export interface Store {
  // agents
  listAgents(): Promise<Agent[]>;

  // tasks
  /** Create unless idempotencyKey exists; returns existing on replay. */
  createTask(spec: {
    type: string; payload: Record<string, unknown>; priority: number;
    agentId: string | null; idempotencyKey: string | null; maxAttempts?: number;
  }): Promise<{ task: Task; created: boolean }>;
  /**
   * Claim up to `limit` ready tasks whose run_after has passed, for the given
   * agents only, respecting per-agent concurrency. Atomic per task: a task is
   * returned by exactly one concurrent caller (conditional update, the same
   * discipline as the platform's outbox claim).
   */
  claimDue(agentIds: string[], limit: number): Promise<Task[]>;
  /** Park a task because the budget cannot admit it. Consumes no attempt. */
  blockForBudget(taskId: string, estimatedCostGbp: number | null): Promise<void>;
  /** budget_blocked tasks for the given agents, oldest first. */
  listBudgetBlocked(agentIds: string[], limit: number): Promise<Task[]>;
  /** Return a budget_blocked task to ready. */
  unblock(taskId: string): Promise<void>;
  completeTask(taskId: string): Promise<void>;
  failTask(taskId: string, opts: { retryInMs: number | null }): Promise<Task>;
  holdForApproval(taskId: string): Promise<void>;

  // runs
  startRun(taskId: string, agentId: string): Promise<Run>;
  finishRun(runId: string, r: {
    status: "succeeded" | "failed"; outcome?: Record<string, unknown>;
    error?: string; costGbp?: number; tokens?: number;
  }): Promise<void>;
  runningCountByAgent(): Promise<Map<string, number>>;

  // approvals / audit / budgets
  createApproval(a: { action: string; payload: Record<string, unknown>; reason: string; requestedBy: string }): Promise<Approval>;
  audit(actor: string, action: string, entity?: string, entityId?: string, detail?: Record<string, unknown>): Promise<void>;
  getBudget(id: string): Promise<Budget | null>;
  /**
   * Atomically reserve headroom: succeeds only if
   * spent + reserved + gbp <= limit. Check-and-reserve in one step is what
   * prevents two concurrent tasks from jointly overspending.
   */
  reserve(budgetId: string, gbp: number): Promise<boolean>;
  /** Settle a reservation: release the estimate, record the actual. */
  settleSpend(budgetId: string, reservedGbp: number, actualGbp: number): Promise<void>;
  addSpend(budgetId: string, gbp: number): Promise<void>;

  // outbox (read-only consumer group over the platform's table)
  readOutboxAfter(cursor: { lastAt: Date; lastId: string }, limit: number): Promise<OutboxEvent[]>;
  getCursor(): Promise<{ lastAt: Date; lastId: string }>;
  setCursor(c: { lastAt: Date; lastId: string }): Promise<void>;
}
