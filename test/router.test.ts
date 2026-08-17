import { test } from "node:test";
import assert from "node:assert/strict";
import { agentForTask, tasksForEvent } from "../src/router.js";
import type { OutboxEvent } from "../src/types.js";

const ev = (event: string, payload: Record<string, unknown> = {}): OutboxEvent =>
  ({ id: "e1", event, companyId: null, payload, at: new Date("2026-08-15T12:00:00Z") });

test("coach signup routes to prospect research at high priority", () => {
  const tasks = tasksForEvent(ev("coach.signed_up", { customerId: "c1" }));
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.type, "research_prospect");
  assert.equal(tasks[0]!.payload["customerId"], "c1");
  assert.ok(tasks[0]!.priority >= 7);
});

test("cancellation-scheduled is a retention signal, not churn bookkeeping", () => {
  const tasks = tasksForEvent(ev("consumer.premium_cancellation_scheduled", { customerId: "c2" }));
  assert.equal(tasks[0]!.type, "retention_review");
});

test("billing issues outrank routine metabolism", () => {
  const dunning = tasksForEvent(ev("consumer.billing_issue"))[0]!;
  const metrics = tasksForEvent(ev("consumer.premium_renewed"))[0]!;
  assert.ok(dunning.priority > metrics.priority);
});

test("unknown events are ignored, not errored — the rules engine owns its own vocabulary", () => {
  assert.deepEqual(tasksForEvent(ev("invoice.paid")), []);
  assert.deepEqual(tasksForEvent(ev("something.novel")), []);
});

test("every task type the router can emit has an owning agent", () => {
  const allEvents = [
    "coach.signed_up", "coach.activated", "coach.client_added", "coach.went_inactive",
    "coach.subscription_started", "coach.subscription_cancelled",
    "consumer.premium_started", "consumer.premium_cancellation_scheduled",
    "consumer.premium_cancelled", "consumer.premium_renewed",
    "consumer.billing_issue", "consumer.daily_rollup",
  ];
  for (const e of allEvents) {
    for (const t of tasksForEvent(ev(e))) {
      assert.notEqual(agentForTask(t.type), null, `${e} -> ${t.type} has no agent`);
    }
  }
});

test("agent split matches the org design", () => {
  assert.equal(agentForTask("research_prospect"), "claude-growth");
  assert.equal(agentForTask("update_growth_metrics"), "gpt-strategist");
  assert.equal(agentForTask("product_feature"), "codex-product");
  assert.equal(agentForTask("integration"), "claude-code-infra");
  assert.equal(agentForTask("no_such_type"), null);
});
