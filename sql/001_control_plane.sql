-- Autopilot control plane — owns the "autopilot" schema.
--
-- The platform (mazidi-platform, Prisma) owns "public" and its migration
-- ledger. This repo deliberately does NOT use Prisma: two Prisma apps sharing
-- one database means two competing shadow-migration workflows against the same
-- catalogue. A dedicated schema with its own tiny ledger keeps the boundary
-- exact: Prisma never sees these tables, this runner never touches public.
--
-- Every timestamp is timestamptz. The platform's public schema uses naive
-- timestamps (a known defect, findings §3.2); repeating that here would put
-- BST/GMT bugs inside retry scheduling, which is exactly where they bite.

CREATE SCHEMA IF NOT EXISTS autopilot;

CREATE TABLE IF NOT EXISTS autopilot._migrations (
  name        text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

-- ── Agent registry ───────────────────────────────────────
-- Which AI does which class of work. Rows are configuration, not code:
-- disabling an agent stops routing to it without a deploy.
CREATE TABLE IF NOT EXISTS autopilot.agent (
  id              text PRIMARY KEY,          -- "claude-growth"
  role            text NOT NULL,             -- human-readable responsibility
  enabled         boolean NOT NULL DEFAULT true,
  max_concurrency integer NOT NULL DEFAULT 2,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ── Tasks ────────────────────────────────────────────────
-- The unit of work. idempotency_key makes creation replay-safe: ingesting the
-- same outbox event twice cannot create two tasks.
CREATE TABLE IF NOT EXISTS autopilot.task (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type            text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}',
  priority        integer NOT NULL DEFAULT 5,
  status          text NOT NULL DEFAULT 'ready'
                  CHECK (status IN ('ready','running','awaiting_approval','completed','failed','cancelled')),
  agent_id        text REFERENCES autopilot.agent(id),
  idempotency_key text UNIQUE,
  attempts        integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL DEFAULT 3,
  run_after       timestamptz NOT NULL DEFAULT now(),  -- backoff scheduling
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_claim_idx ON autopilot.task (status, run_after, priority DESC);

-- ── Runs ─────────────────────────────────────────────────
-- One attempt of one task by one agent. Cost lands here first and is
-- aggregated into budgets; an attempt that errors still records its spend.
CREATE TABLE IF NOT EXISTS autopilot.run (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     uuid NOT NULL REFERENCES autopilot.task(id),
  agent_id    text NOT NULL,
  status      text NOT NULL DEFAULT 'running'
              CHECK (status IN ('running','succeeded','failed')),
  outcome     jsonb,
  error       text,
  cost_gbp    numeric(10,4) NOT NULL DEFAULT 0,
  tokens      integer NOT NULL DEFAULT 0,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS run_task_idx ON autopilot.run (task_id);

-- ── Approvals ────────────────────────────────────────────
-- The policy engine emits these instead of acting. Approval is per-action:
-- one row authorises one payload, never a category.
CREATE TABLE IF NOT EXISTS autopilot.approval (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action       text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}',
  reason       text NOT NULL,
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','approved','rejected','expired')),
  requested_by text NOT NULL,
  decided_by   text,
  decided_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ── Audit ────────────────────────────────────────────────
-- Append-only. No UPDATE or DELETE is ever issued against this table by code;
-- enforcement beyond convention can be added with a trigger once the platform
-- decides on a shared audit policy.
CREATE TABLE IF NOT EXISTS autopilot.audit (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor     text NOT NULL,           -- "heartbeat", "policy", agent id, or user
  action    text NOT NULL,
  entity    text,
  entity_id text,
  detail    jsonb,
  at        timestamptz NOT NULL DEFAULT now()
);

-- ── Budgets ──────────────────────────────────────────────
-- Hard ceilings the policy engine checks BEFORE dispatch. spent_gbp is
-- maintained by the heartbeat from run costs.
CREATE TABLE IF NOT EXISTS autopilot.budget (
  id         text PRIMARY KEY,        -- "agent_spend_daily"
  period     text NOT NULL CHECK (period IN ('daily','monthly')),
  limit_gbp  numeric(10,2) NOT NULL,
  spent_gbp  numeric(10,2) NOT NULL DEFAULT 0,
  reset_at   timestamptz NOT NULL DEFAULT now()
);

-- ── Outbox cursor ────────────────────────────────────────
-- The platform's rules engine CLAIMS OutboxEvent rows (sets processedAt).
-- The orchestrator must never race it for the same claim, so it reads with an
-- independent cursor instead: a second consumer group over the same log.
-- (last_at, last_id) orders ties deterministically.
CREATE TABLE IF NOT EXISTS autopilot.outbox_cursor (
  id      text PRIMARY KEY DEFAULT 'main',
  last_at timestamptz NOT NULL DEFAULT 'epoch',
  last_id text NOT NULL DEFAULT ''
);
INSERT INTO autopilot.outbox_cursor (id) VALUES ('main') ON CONFLICT DO NOTHING;

-- ── Default agents ───────────────────────────────────────
INSERT INTO autopilot.agent (id, role, max_concurrency) VALUES
  ('claude-growth',    'Growth & revenue intelligence: research, qualification, outreach drafting, reply classification, feedback extraction', 3),
  ('gpt-strategist',   'Strategy & capital allocation: bottleneck detection, experiment evaluation, KEEP/ITERATE/KILL', 1),
  ('codex-product',    'Product engineering: customer-facing coach app features', 2),
  ('claude-code-infra','Infrastructure: integrations, workers, queues, observability', 2)
ON CONFLICT (id) DO NOTHING;

INSERT INTO autopilot._migrations (name) VALUES ('001_control_plane') ON CONFLICT DO NOTHING;
