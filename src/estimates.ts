/**
 * Cost estimation — configuration, not code scattered through the orchestrator.
 *
 * An estimate is looked up most-specific-first: exact (task, agent) pair, then
 * task type, then agent default. A PAID agent with no estimate anywhere fails
 * CLOSED: the task parks as budget_blocked rather than executing on an assumed
 * zero, because "we forgot to price this" must never mean "it runs for free".
 *
 * Agents in zeroCostAgents are deterministic (no inference spend) and their
 * tasks run even at a budget ceiling.
 */
export interface EstimateTable {
  /** "taskType@agentId" exact overrides */
  byTaskAndAgent?: Record<string, number>;
  byTask?: Record<string, number>;
  byAgentDefault?: Record<string, number>;
  /** agents whose work costs nothing (deterministic, no model calls) */
  zeroCostAgents?: readonly string[];
}

export const DEFAULT_ESTIMATES: EstimateTable = {
  byTask: {
    research_prospect: 0.40,
    score_prospect: 0.10,
    draft_outreach: 0.15,
    draft_dunning_outreach: 0.15,
    classify_reply: 0.05,
    retention_review: 0.20,
    extract_feedback: 0.10,
    update_growth_metrics: 0.05,
    evaluate_experiment: 0.30,
    prioritise_roadmap: 0.30,
    product_feature: 2.00,
    product_bugfix: 1.00,
    integration: 1.00,
    worker_fix: 0.50,
    observability: 0.50,
  },
  byAgentDefault: {},
  zeroCostAgents: [],
};

/**
 * Returns the estimated cost in GBP, 0 for zero-cost agents, or null when no
 * estimate exists for a paid agent (fail closed at the call site).
 */
export function estimateCost(
  taskType: string,
  agentId: string,
  table: EstimateTable = DEFAULT_ESTIMATES,
): number | null {
  if (table.zeroCostAgents?.includes(agentId)) return 0;
  const exact = table.byTaskAndAgent?.[`${taskType}@${agentId}`];
  if (exact !== undefined) return exact;
  const byTask = table.byTask?.[taskType];
  if (byTask !== undefined) return byTask;
  const byAgent = table.byAgentDefault?.[agentId];
  if (byAgent !== undefined) return byAgent;
  return null;
}
