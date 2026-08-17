import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentAdapter, AgentResult } from "../src/agents.js";
import { heartbeat } from "../src/heartbeat.js";
import { MemStore } from "../src/store-mem.js";
import { estimateCost } from "../src/estimates.js";
import type { OutboxEvent } from "../src/types.js";

/**
 * Finding B — budget reservations. The failure being designed against is
 * check-then-act: two tasks reading the same headroom and jointly overspending.
 */

class FakeAdapter implements AgentAdapter {
  calls = 0;
  constructor(readonly agentId: string, private opts: { costGbp?: number; fail?: boolean } = {}) {}
  isConfigured() { return true; }
  async execute(): Promise<AgentResult> {
    this.calls++;
    if (this.opts.fail) throw new Error("boom");
    return { outcome: { ok: true }, costGbp: this.opts.costGbp ?? 0, tokens: 100 };
  }
}

const ev = (id: string, event: string, minute: number): OutboxEvent =>
  ({ id, event, companyId: "co1", payload: { customerId: `c-${id}` }, at: new Date(Date.UTC(2026, 7, 15, 10, minute)) });

// research_prospect estimates at 0.40 in DEFAULT_ESTIMATES
const RESEARCH_EST = estimateCost("research_prospect", "claude-growth")!;

function store(budget: { limitGbp: number; spentGbp?: number }, events: OutboxEvent[]) {
  const s = new MemStore();
  s.agents = [{ id: "claude-growth", role: "g", enabled: true, maxConcurrency: 10 }];
  s.budgets.set("b", { id: "b", period: "daily", limitGbp: budget.limitGbp, spentGbp: budget.spentGbp ?? 0, reservedGbp: 0 });
  s.outbox = events;
  return s;
}

test("a budget exactly at its ceiling admits no further paid work", async () => {
  const s = store({ limitGbp: 5, spentGbp: 5 }, [ev("e1", "coach.signed_up", 0)]);
  const a = new FakeAdapter("claude-growth", { costGbp: RESEARCH_EST });
  const sum = await heartbeat(s, [a], { spendBudgetId: "b" });
  assert.equal(a.calls, 0, "adapter must not execute");
  assert.equal(sum.tasksBudgetBlocked, 1);
  const t = [...s.tasks.values()][0]!;
  assert.equal(t.status, "budget_blocked", "parked visibly");
  assert.equal(t.attempts, 0, "no retry consumed");
});

test("reservation prevents two concurrent tasks from jointly overspending", async () => {
  // Budget 0.50; two research tasks at 0.40 each would jointly spend 0.80
  // under check-then-act. With reservations exactly one runs.
  const s = store({ limitGbp: 0.5 }, [ev("e1", "coach.signed_up", 0), ev("e2", "coach.signed_up", 1)]);
  const a = new FakeAdapter("claude-growth", { costGbp: RESEARCH_EST });
  const sum = await heartbeat(s, [a], { spendBudgetId: "b" });
  assert.equal(a.calls, 1, "exactly one execution");
  assert.equal(sum.runsSucceeded, 1);
  assert.equal(sum.tasksBudgetBlocked, 1);
  const b = s.budgets.get("b")!;
  assert.ok(b.spentGbp <= b.limitGbp + 1e-9, `spent ${b.spentGbp} within limit`);
  assert.equal(b.reservedGbp, 0, "reservation settled after run");
});

test("failed tasks release their reservation", async () => {
  const s = store({ limitGbp: 1 }, [ev("e1", "coach.signed_up", 0)]);
  const a = new FakeAdapter("claude-growth", { fail: true });
  await heartbeat(s, [a], { spendBudgetId: "b" });
  const b = s.budgets.get("b")!;
  assert.equal(b.reservedGbp, 0, "reservation released on failure");
  assert.equal(b.spentGbp, 0, "no phantom spend");
  const t = [...s.tasks.values()][0]!;
  assert.equal(t.status, "ready", "failure retries as before — budget did not eat the attempt path");
  assert.equal(t.attempts, 1);
});

test("actual cost replaces the reservation, not adds to it", async () => {
  const s = store({ limitGbp: 10 }, [ev("e1", "coach.signed_up", 0)]);
  const a = new FakeAdapter("claude-growth", { costGbp: 0.10 }); // actual < estimate 0.40
  await heartbeat(s, [a], { spendBudgetId: "b" });
  const b = s.budgets.get("b")!;
  assert.equal(b.reservedGbp, 0);
  assert.ok(Math.abs(b.spentGbp - 0.10) < 1e-9, `spent=${b.spentGbp} is the actual, not the estimate`);
});

test("zero-cost deterministic work still runs at the budget ceiling", async () => {
  const s = store({ limitGbp: 5, spentGbp: 5 }, [ev("e1", "coach.signed_up", 0)]);
  const a = new FakeAdapter("claude-growth", { costGbp: 0 });
  const sum = await heartbeat(s, [a], {
    spendBudgetId: "b",
    estimates: { byTask: {}, zeroCostAgents: ["claude-growth"] },
  });
  assert.equal(a.calls, 1, "zero-cost work executes at ceiling");
  assert.equal(sum.runsSucceeded, 1);
  assert.equal(sum.tasksBudgetBlocked, 0);
});

test("missing estimate on a paid agent fails closed, never assumes zero", async () => {
  const s = store({ limitGbp: 100 }, [ev("e1", "coach.signed_up", 0)]);
  const a = new FakeAdapter("claude-growth", { costGbp: 0.4 });
  const sum = await heartbeat(s, [a], {
    spendBudgetId: "b",
    estimates: { byTask: {} }, // no estimate anywhere, agent not zero-cost
  });
  assert.equal(a.calls, 0, "must not execute unpriced work");
  assert.equal(sum.tasksBudgetBlocked, 1);
  assert.equal([...s.tasks.values()][0]!.status, "budget_blocked");
});

test("overage is recorded and blocks subsequent paid work", async () => {
  // estimate 0.40, actual 4.70 -> headroom 0.30 < next estimate 0.40
  const s = store({ limitGbp: 5 }, [ev("e1", "coach.signed_up", 0), ev("e2", "coach.signed_up", 1)]);
  const a = new FakeAdapter("claude-growth", { costGbp: 4.70 });
  // batch=1 so the runs are sequential heartbeats, like real life
  await heartbeat(s, [a], { spendBudgetId: "b", batch: 1 });
  const overage = s.auditLog.find((x) => x.action === "budget.overage");
  assert.ok(overage, "overage audited");
  const sum2 = await heartbeat(s, [a], { spendBudgetId: "b" });
  assert.equal(a.calls, 1, "second paid task must not execute");
  assert.equal(sum2.tasksBudgetBlocked, 1);
  const b = s.budgets.get("b")!;
  assert.ok(b.spentGbp <= b.limitGbp + 1e-9);
});

test("budget_blocked work unblocks and runs once headroom returns", async () => {
  const s = store({ limitGbp: 0.5 }, [ev("e1", "coach.signed_up", 0), ev("e2", "coach.signed_up", 1)]);
  const a = new FakeAdapter("claude-growth", { costGbp: 0.40 }); // actual = estimate
  const sum1 = await heartbeat(s, [a], { spendBudgetId: "b" });
  // task1 settles at 0.40; headroom 0.10 < estimate 0.40 -> task2 parks
  assert.equal(a.calls, 1);
  assert.equal(sum1.tasksBudgetBlocked, 1);

  // Still no headroom on the next pass: stays parked, burns nothing.
  const sumStill = await heartbeat(s, [a], { spendBudgetId: "b" });
  assert.equal(sumStill.tasksUnblocked, 0);
  assert.equal(a.calls, 1);
  assert.equal([...s.tasks.values()][1]!.attempts, 0, "waiting costs no attempts");

  // Budget reset / approved increase -> unblock pass admits it.
  s.budgets.get("b")!.limitGbp = 1.0;
  const sum2 = await heartbeat(s, [a], { spendBudgetId: "b" });
  assert.equal(sum2.tasksUnblocked, 1, "blocked task returned to ready");
  assert.equal(sum2.runsSucceeded, 1, "and executed in the same pass");
  assert.equal(a.calls, 2);
});
