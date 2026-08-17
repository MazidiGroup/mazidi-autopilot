/**
 * Deterministic routing. Two pure maps, no LLM anywhere near them:
 *
 *   1. event  -> tasks   (what work does this business event create?)
 *   2. task   -> agent   (which AI owns that class of work?)
 *
 * Rules live in code, not in the database, so a routing change is a reviewed
 * diff with a commit message — the same reasoning as the platform's
 * EVENT_COMPANY map. Unknown events are IGNORED by design (the platform's
 * rules engine handles its own vocabulary; we only orchestrate what we know),
 * and unknown task types return null so the caller must handle them loudly.
 */
import type { OutboxEvent } from "./types.js";

export interface TaskSpec {
  type: string;
  payload: Record<string, unknown>;
  priority: number;
}

/** Business events the orchestrator reacts to, and the work each creates. */
export function tasksForEvent(ev: OutboxEvent): TaskSpec[] {
  switch (ev.event) {
    // A coach signing up is the top of the B2B funnel: research them while
    // the signup is warm.
    case "coach.signed_up":
      return [{
        type: "research_prospect",
        payload: { customerId: ev.payload["customerId"], source: "coach_signup" },
        priority: 7,
      }];

    // First client attached = activation. Worth a strategist look at cohort
    // level, not per-event — so lower priority, and the payload carries the
    // event rather than a person.
    case "coach.activated":
    case "coach.client_added":
      return [{
        type: "update_growth_metrics",
        payload: { event: ev.event, at: ev.at.toISOString() },
        priority: 3,
      }];

    // Churn risk: the retention play is judgment work → claude-growth.
    case "coach.went_inactive":
    case "consumer.premium_cancellation_scheduled":
      return [{
        type: "retention_review",
        payload: { event: ev.event, customerId: ev.payload["customerId"] ?? null },
        priority: 6,
      }];

    // Revenue facts: fold into metrics; the strategist reads aggregates.
    case "coach.subscription_started":
    case "coach.subscription_cancelled":
    case "consumer.premium_started":
    case "consumer.premium_cancelled":
    case "consumer.premium_renewed":
    case "consumer.daily_rollup":
      return [{
        type: "update_growth_metrics",
        payload: { event: ev.event, data: ev.payload },
        priority: 4,
      }];

    // Dunning is time-sensitive but the ACTION (emailing a customer about
    // billing) is sensitive comms → route to growth, which drafts; policy
    // gates any actual send.
    case "consumer.billing_issue":
      return [{
        type: "draft_dunning_outreach",
        payload: { customerId: ev.payload["customerId"] ?? null, data: ev.payload },
        priority: 8,
      }];

    default:
      return []; // not ours — the platform rules engine owns its own vocabulary
  }
}

/** Which agent owns each task type. Null = unroutable; caller fails the task loudly. */
export function agentForTask(taskType: string): string | null {
  switch (taskType) {
    case "research_prospect":
    case "score_prospect":
    case "draft_outreach":
    case "draft_dunning_outreach":
    case "classify_reply":
    case "retention_review":
    case "extract_feedback":
      return "claude-growth";

    case "update_growth_metrics":
    case "evaluate_experiment":
    case "prioritise_roadmap":
      return "gpt-strategist";

    case "product_feature":
    case "product_bugfix":
      return "codex-product";

    case "integration":
    case "worker_fix":
    case "observability":
      return "claude-code-infra";

    default:
      return null;
  }
}
