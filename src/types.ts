/** Shared domain types for the control plane. */

export type TaskStatus =
  | "ready" | "running" | "awaiting_approval" | "budget_blocked"
  | "completed" | "failed" | "cancelled";

export interface Task {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  priority: number;
  status: TaskStatus;
  agentId: string | null;
  idempotencyKey: string | null;
  attempts: number;
  maxAttempts: number;
  runAfter: Date;
  /** Reserved against the budget before execution; null = not estimated yet. */
  estimatedCostGbp: number | null;
}

export interface Run {
  id: string;
  taskId: string;
  agentId: string;
  status: "running" | "succeeded" | "failed";
  outcome: Record<string, unknown> | null;
  error: string | null;
  costGbp: number;
  tokens: number;
}

export interface Agent {
  id: string;
  role: string;
  enabled: boolean;
  maxConcurrency: number;
}

export interface Approval {
  id: string;
  action: string;
  payload: Record<string, unknown>;
  reason: string;
  status: "pending" | "approved" | "rejected" | "expired";
  requestedBy: string;
}

export interface Budget {
  id: string;
  period: "daily" | "monthly";
  limitGbp: number;
  /** Actual, settled spend. */
  spentGbp: number;
  /** Estimated spend of in-flight work, held until each run settles. */
  reservedGbp: number;
}

/** A row read from the platform's public."OutboxEvent" (read-only here). */
export interface OutboxEvent {
  id: string;
  event: string;
  companyId: string | null;
  payload: Record<string, unknown>;
  at: Date;
}
