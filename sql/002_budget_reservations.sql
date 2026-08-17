-- Budget reservations (Finding B).
--
-- Spend control was check-then-act: read the budget, decide, execute, add
-- spend afterwards. Two concurrent tasks could each pass the check against the
-- same headroom and jointly overspend. Reservations close the race: headroom
-- is claimed BEFORE execution in one atomic statement, and released on
-- completion when the actual cost is recorded.

ALTER TABLE autopilot.budget ADD COLUMN IF NOT EXISTS reserved_gbp numeric(10,2) NOT NULL DEFAULT 0;

ALTER TABLE autopilot.task ADD COLUMN IF NOT EXISTS estimated_cost_gbp numeric(10,4);

-- New task state: parked because the budget cannot admit it. Distinct from
-- 'ready' so blocked work is visible, and distinct from 'failed' so waiting
-- for budget never consumes retry attempts.
ALTER TABLE autopilot.task DROP CONSTRAINT IF EXISTS task_status_check;
ALTER TABLE autopilot.task ADD CONSTRAINT task_status_check
  CHECK (status IN ('ready','running','awaiting_approval','budget_blocked','completed','failed','cancelled'));

INSERT INTO autopilot._migrations (name) VALUES ('002_budget_reservations') ON CONFLICT DO NOTHING;
