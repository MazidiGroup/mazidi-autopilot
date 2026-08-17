import { test } from "node:test";
import assert from "node:assert/strict";
import { ALWAYS_GATED, DEFAULT_CONFIG, decide } from "../src/policy.js";

test("every owner-gated action requires approval regardless of cost", () => {
  for (const action of ALWAYS_GATED) {
    const d = decide({ action, estimatedCostGbp: 0 });
    assert.equal(d.verdict, "require_approval", action);
  }
});

test("ungated cheap action is allowed", () => {
  assert.deepEqual(decide({ action: "research_prospect", estimatedCostGbp: 0.5 }), { verdict: "allow" });
});

test("spend above the autonomous limit requires approval even when ungated", () => {
  const d = decide({ action: "research_prospect", estimatedCostGbp: DEFAULT_CONFIG.maxAutonomousSpendGbp + 1 });
  assert.equal(d.verdict, "require_approval");
});

test("spend exactly at the limit is allowed — the limit is a ceiling, not a trigger", () => {
  const d = decide({ action: "research_prospect", estimatedCostGbp: DEFAULT_CONFIG.maxAutonomousSpendGbp });
  assert.equal(d.verdict, "allow");
});

test("budget exhaustion requires approval", () => {
  const d = decide({
    action: "research_prospect",
    estimatedCostGbp: 10,
    budget: { id: "agent_spend_daily", period: "daily", limitGbp: 20, spentGbp: 15 },
  });
  assert.equal(d.verdict, "require_approval");
});

test("config can add gated actions but cannot remove the defaults", () => {
  const cfg = { ...DEFAULT_CONFIG, extraGatedActions: ["custom.thing"] };
  assert.equal(decide({ action: "custom.thing" }, cfg).verdict, "require_approval");
  // attempting to "clear" defaults via config has no effect on them
  const hostile = { maxAutonomousSpendGbp: 1e9, extraGatedActions: [] };
  assert.equal(decide({ action: "billing.refund" }, hostile).verdict, "require_approval");
});

test("policy is deterministic", () => {
  const req = { action: "draft_outreach", estimatedCostGbp: 3 };
  assert.deepEqual(decide(req), decide(req));
});
