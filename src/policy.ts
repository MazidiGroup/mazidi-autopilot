/**
 * Spend/risk policy — the line between autonomy and approval.
 *
 * Pure and deterministic: same inputs, same decision, no I/O. The heartbeat
 * consults it BEFORE dispatch; anything it does not explicitly allow becomes
 * an approval row rather than an action. AI proposes, policy disposes.
 *
 * The gated list is owner-set (2026-08-15) and deliberately hardcoded as the
 * DEFAULT: configuration can tighten policy at runtime but can never silently
 * loosen it below this floor — a compromised or miswritten config row must not
 * be able to un-gate refunds.
 */
import type { Budget } from "./types.js";

/** Actions that always require explicit human approval, regardless of size. */
export const ALWAYS_GATED = [
  "outbound.bulk_send",          // mass/bulk outbound
  "outbound.volume_change",      // major send-volume changes
  "billing.stripe_price_create", // live Stripe price creation/change
  "billing.charge",              // charges
  "billing.refund",              // refunds
  "db.destructive_migration",    // destructive migrations
  "security.production_change",  // sensitive production/security changes
  "deploy.production",           // major production deploys
  "comms.public_claim",          // public claims
  "strategy.pivot",              // material business pivots
] as const;

export interface PolicyConfig {
  /** Spend above this (GBP) requires approval even for ungated actions. */
  maxAutonomousSpendGbp: number;
  /** Extra gated actions from config. Additive only — cannot remove defaults. */
  extraGatedActions: readonly string[];
}

export const DEFAULT_CONFIG: PolicyConfig = {
  maxAutonomousSpendGbp: 100, // 08_BUSINESS_STATE_EXAMPLE.json: constraints.max_autonomous_spend
  extraGatedActions: [],
};

export type Decision =
  | { verdict: "allow" }
  | { verdict: "require_approval"; reason: string };

export interface ActionRequest {
  action: string;
  estimatedCostGbp?: number;
  /** Budget the spend would draw from, if any. */
  budget?: Budget | undefined;
}

export function decide(req: ActionRequest, cfg: PolicyConfig = DEFAULT_CONFIG): Decision {
  const gated = new Set<string>([...ALWAYS_GATED, ...cfg.extraGatedActions]);

  if (gated.has(req.action)) {
    return { verdict: "require_approval", reason: `"${req.action}" is approval-gated` };
  }

  const cost = req.estimatedCostGbp ?? 0;
  if (cost > cfg.maxAutonomousSpendGbp) {
    return {
      verdict: "require_approval",
      reason: `estimated £${cost.toFixed(2)} exceeds autonomous limit £${cfg.maxAutonomousSpendGbp.toFixed(2)}`,
    };
  }

  if (req.budget && req.budget.spentGbp + cost > req.budget.limitGbp) {
    return {
      verdict: "require_approval",
      reason: `budget "${req.budget.id}" would exceed limit ` +
        `(£${req.budget.spentGbp.toFixed(2)} spent + £${cost.toFixed(2)} > £${req.budget.limitGbp.toFixed(2)})`,
    };
  }

  return { verdict: "allow" };
}
