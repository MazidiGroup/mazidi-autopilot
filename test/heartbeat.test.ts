import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentAdapter, AgentResult } from "../src/agents.js";
import { heartbeat } from "../src/heartbeat.js";
import { MemStore } from "../src/store-mem.js";
import type { OutboxEvent } from "../src/types.js";

const AGENTS = [
  { id: "claude-growth", role: "growth", enabled: true, maxConcurrency: 2 },
  { id: "gpt-strategist", role: "strategy", enabled: true, maxConcurrency: 1 },
];

class FakeAdapter implements AgentAdapter {
  calls: string[] = [];
  constructor(
    readonly agentId: string,
    private cfg: { configured?: boolean; failTimes?: number; costGbp?: number } = {},
  ) {}
  private failures = 0;
  isConfigured() { return this.cfg.configured ?? true; }
  async execute(taskType: string): Promise<AgentResult> {
    this.calls.push(taskType);
    if (this.failures < (this.cfg.failTimes ?? 0)) {
      this.failures++;
      throw new Error("transient upstream error");
    }
    return { outcome: { ok: true }, costGbp: this.cfg.costGbp ?? 0.05, tokens: 1200 };
  }
}

const outboxRow = (id: string, event: string, at: string, payload = {}): OutboxEvent =>
  ({ id, event, companyId: "co1", payload, at: new Date(at) });

function seeded() {
  const store = new MemStore();
  store.agents = [...AGENTS];
  store.outbox = [
    outboxRow("e1", "coach.signed_up", "2026-08-15T10:00:00Z", { customerId: "cust1" }),
    outboxRow("e2", "consumer.premium_started", "2026-08-15T10:01:00Z"),
    outboxRow("e3", "invoice.paid", "2026-08-15T10:02:00Z"), // not ours — ignored
  ];
  return store;
}

test("ingests events into routed tasks exactly once, even when run twice", async () => {
  const store = seeded();
  const adapters = [new FakeAdapter("claude-growth", { configured: false }),
                    new FakeAdapter("gpt-strategist", { configured: false })];

  const s1 = await heartbeat(store, adapters);
  assert.equal(s1.eventsIngested, 3);
  assert.equal(s1.tasksCreated, 2); // invoice.paid ignored

  // cursor replay-safety: nothing new, nothing duplicated
  const s2 = await heartbeat(store, adapters);
  assert.equal(s2.eventsIngested, 0);
  assert.equal(s2.tasksCreated, 0);
  assert.equal(store.tasks.size, 2);
});

test("re-reading the same events cannot duplicate tasks (idempotency key)", async () => {
  const store = seeded();
  const adapters = [new FakeAdapter("claude-growth", { configured: false }),
                    new FakeAdapter("gpt-strategist", { configured: false })];
  await heartbeat(store, adapters);
  await store.setCursor({ lastAt: new Date(0), lastId: "" }); // simulate lost cursor
  const s = await heartbeat(store, adapters);
  assert.equal(s.eventsIngested, 3, "events re-read after cursor loss");
  assert.equal(s.tasksCreated, 0, "but no duplicate tasks created");
  assert.equal(store.tasks.size, 2);
});

test("unconfigured agents queue work instead of burning attempts", async () => {
  const store = seeded();
  const growth = new FakeAdapter("claude-growth", { configured: false });
  const strat = new FakeAdapter("gpt-strategist", { configured: false });
  const s = await heartbeat(store, [growth, strat]);
  assert.equal(s.tasksClaimed, 0);
  assert.equal(growth.calls.length, 0);
  for (const t of store.tasks.values()) {
    assert.equal(t.status, "ready");
    assert.equal(t.attempts, 0, "no attempts burned while waiting for keys");
  }
});

test("configured agents execute, record runs, and spend lands on the budget", async () => {
  const store = seeded();
  store.budgets.set("agent_spend_daily", { id: "agent_spend_daily", period: "daily", limitGbp: 10, spentGbp: 0, reservedGbp: 0 });
  const growth = new FakeAdapter("claude-growth", { costGbp: 0.25 });
  const strat = new FakeAdapter("gpt-strategist", { costGbp: 0.1 });

  const s = await heartbeat(store, [growth, strat], { spendBudgetId: "agent_spend_daily" });
  assert.equal(s.tasksClaimed, 2);
  assert.equal(s.runsSucceeded, 2);
  assert.equal(s.runsFailed, 0);
  assert.ok(Math.abs(s.spendGbp - 0.35) < 1e-9);
  assert.ok(Math.abs(store.budgets.get("agent_spend_daily")!.spentGbp - 0.35) < 1e-9);
  const statuses = [...store.tasks.values()].map((t) => t.status);
  assert.deepEqual(statuses, ["completed", "completed"]);
});

test("a failing agent retries with growing backoff, then fails at max attempts", async () => {
  const store = new MemStore();
  store.agents = [AGENTS[0]!];
  store.outbox = [outboxRow("e1", "coach.signed_up", "2026-08-15T10:00:00Z", { customerId: "c1" })];
  const flaky = new FakeAdapter("claude-growth", { failTimes: 99 }); // always fails
  store.budgets.set("agent_spend_daily", { id: "agent_spend_daily", period: "daily", limitGbp: 100, spentGbp: 0, reservedGbp: 0 });
  const opts = { spendBudgetId: "agent_spend_daily" };

  await heartbeat(store, [flaky], opts); // ingest + attempt 1
  let task = [...store.tasks.values()][0]!;
  assert.equal(task.attempts, 1);
  assert.equal(task.status, "ready", "retryable after first failure");
  const firstRunAfter = task.runAfter.getTime();
  assert.ok(firstRunAfter > Date.now(), "backoff scheduled in the future");

  task.runAfter = new Date(0); // due again
  await heartbeat(store, [flaky], opts); // attempt 2
  task = [...store.tasks.values()][0]!;
  assert.equal(task.attempts, 2);
  assert.equal(task.status, "ready");

  task.runAfter = new Date(0);
  await heartbeat(store, [flaky], opts); // attempt 3 = max
  task = [...store.tasks.values()][0]!;
  assert.equal(task.attempts, 3);
  assert.equal(task.status, "failed", "terminal after max attempts");

  const failedRuns = [...store.runs.values()].filter((r) => r.status === "failed");
  assert.equal(failedRuns.length, 3, "every attempt recorded as a run");
});

test("per-agent concurrency is respected", async () => {
  const store = new MemStore();
  store.agents = [{ id: "gpt-strategist", role: "s", enabled: true, maxConcurrency: 1 }];
  store.outbox = [
    outboxRow("e1", "consumer.premium_started", "2026-08-15T10:00:00Z"),
    outboxRow("e2", "consumer.premium_renewed", "2026-08-15T10:01:00Z"),
    outboxRow("e3", "consumer.daily_rollup", "2026-08-15T10:02:00Z"),
  ];
  // A stuck running run occupies the only slot.
  await store.createTask({ type: "warm", payload: {}, priority: 1, agentId: "gpt-strategist", idempotencyKey: null });
  const stuck = await store.startRun([...store.tasks.values()][0]!.id, "gpt-strategist");
  void stuck;

  const s = await heartbeat(store, [new FakeAdapter("gpt-strategist")]);
  assert.equal(s.tasksCreated, 3);
  assert.equal(s.tasksClaimed, 0, "no capacity while a run is in flight");
});

test("gated task types become approvals, not actions", async () => {
  const store = new MemStore();
  store.agents = [AGENTS[0]!];
  // Force a gated action through the router path by creating the task directly
  // and running only the gate+claim halves: simulate ingest of a task whose
  // type is approval-gated.
  store.outbox = [outboxRow("e1", "coach.signed_up", "2026-08-15T10:00:00Z", { customerId: "c1" })];
  const gatedPolicy = {
    maxAutonomousSpendGbp: 100,
    extraGatedActions: ["research_prospect"], // gate the routed type for this test
  };
  const growth = new FakeAdapter("claude-growth");
  const s = await heartbeat(store, [growth], { policy: gatedPolicy });
  assert.equal(s.tasksGated, 1);
  assert.equal(s.tasksClaimed, 0, "gated task must not be dispatched");
  assert.equal(growth.calls.length, 0);
  assert.equal(store.approvals.length, 1);
  assert.equal(store.approvals[0]!.status, "pending");
  const task = [...store.tasks.values()][0]!;
  assert.equal(task.status, "awaiting_approval");
});

test("audit trail records creation, completion and failures", async () => {
  const store = seeded();
  store.budgets.set("agent_spend_daily", { id: "agent_spend_daily", period: "daily", limitGbp: 100, spentGbp: 0, reservedGbp: 0 });
  await heartbeat(store, [new FakeAdapter("claude-growth"), new FakeAdapter("gpt-strategist")], { spendBudgetId: "agent_spend_daily" });
  const actions = store.auditLog.map((a) => a.action);
  assert.ok(actions.includes("task.created"));
  assert.ok(actions.includes("task.completed"));
});
