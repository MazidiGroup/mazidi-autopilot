# mazidi-autopilot

Deterministic orchestration control plane for Mazidi Group.
**AI handles judgment. This software handles control.**

The four agents (Claude = growth/revenue, GPT = strategy/evaluation,
Codex = product engineering, Claude Code = infrastructure) never talk to each
other and never decide what runs. This service reads business events, creates
tasks, routes them deterministically, enforces spend/risk policy, executes
agents with retries and concurrency caps, and records everything.

## Architecture

```
platform (mazidi-platform, public schema)          this repo (autopilot schema)
────────────────────────────────────────           ─────────────────────────────
apps emit → OutboxEvent ──────────────────read────▶ heartbeat
            │                             cursor      1 ingest  → task (idempotent)
            └─ rules engine claims                    2 gate    → approval | proceed
               processedAt (theirs)                   3 claim   → per-agent concurrency
                                                      4 execute → run (+cost)
                                                      5 settle  → complete | backoff | fail
```

Two consumers, one log, zero contention: the platform's rules engine **claims**
`OutboxEvent` rows (`processedAt`); this service only **reads** them through its
own `(at, id)` cursor. It never writes to the platform's tables.

### Schema boundary

The platform owns `public` and its Prisma migration ledger. This repo owns the
`autopilot` schema with its own tiny SQL migration runner — deliberately not
Prisma, because two Prisma workflows against one database compete for the same
catalogue. Tables: `agent`, `task`, `run`, `approval`, `audit`, `budget`,
`outbox_cursor`, `_migrations`. Every timestamp is `timestamptz`.

### Policy (`src/policy.ts`)

Pure and deterministic. The owner-set gated list (bulk outbound, send-volume
changes, Stripe price changes, charges/refunds, destructive migrations,
security changes, production deploys, public claims, pivots) is hardcoded as a
**floor**: config can add gated actions, it can never remove these. Spend above
the autonomous limit (default £100) or over budget → approval row, not action.

### Degraded mode is "waiting", not "failing"

An agent with no API key configured has its tasks left `ready` and visible —
no retry attempts are burned against a missing key. Configure the key and the
next heartbeat picks the queue up.

## Run

```bash
npm install && npm test          # 21 tests, no database needed
npm run build
AUTOPILOT_DATABASE_URL=... npm run migrate     # applies sql/ to the autopilot schema
AUTOPILOT_DATABASE_URL=... npm run heartbeat   # one pass; schedule via cron
```

Env:

| Var | Purpose |
|---|---|
| `AUTOPILOT_DATABASE_URL` | Postgres (mazidi-prod). Falls back to `DATABASE_URL`. |
| `ANTHROPIC_API_KEY` | enables claude-growth, claude-code-infra |
| `OPENAI_API_KEY` | enables gpt-strategist, codex-product |
| `AUTOPILOT_SPEND_BUDGET` | budget id drawn on by agent spend (default `agent_spend_daily`) |

## Status

Core loop built and tested (21 tests: policy floor, routing determinism,
ingest idempotency under cursor loss, retry/backoff to terminal failure,
per-agent concurrency, approval gating, audit coverage). Agent adapters are
env-keyed seams — inference wiring is the next change, and it is deliberately
unstubbed: fake agent output flowing into a CRM is worse than none.

Activation order (owner-gated): platform migration → green preview →
`verify-backbone.mjs` proves one real event end-to-end → `npm run migrate` →
schedule the heartbeat.
