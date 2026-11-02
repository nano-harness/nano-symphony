# Cost and Reliability Metrics

[中文](./metrics-cost-and-reliability.zh-CN.md)

This document describes how nano-symphony measures the two dimensions that
loop engineering is accountable for: **cost** and **run-to-run reliability**.

## Cost as a first-class metric

Evaluation practice for agents tends to report accuracy while treating cost
as an afterthought, yet systems with similar accuracy can differ by an order
of magnitude (and more) in token spend. For an orchestrator that runs agents
repeatedly and unattended, cost is a first-class operational metric, not a
byproduct.

What nano-symphony records today:

- **Per attempt** — every worker attempt writes one `llm_calls` row with
  input/output tokens, `cost_usd` (when the agent reports it), and wall/API
  durations (`src/db/tracker-llm-calls.ts`, written from
  `src/orchestrator/worker.ts`).
- **Per issue** — `symphony_runs.token_*` holds the latest attempt's token
  counts; `issue_metrics` stores a durable terminal snapshot (attempts,
  sessions, tokens, cost, duration) once an issue reaches
  `done` / `cancelled` / `blocked`.
- **Budgets as enforcement, not just telemetry** — `cost_budget_usd` and
  `token_budget` on an issue, and `max_budget_tokens` in plan-run metadata,
  abort work when spend exceeds the limit; the plan executor recomputes
  spend across all sub-issues on every scheduling decision.
- **Export surfaces** — `GET /api/v1/issues/:id/llm-calls[/summary]`,
  `GET /api/v1/issues/summary`, `GET /api/v1/metrics/export`, and Prometheus
  counters (`symphony_tokens_total`, `symphony_agent_attempts_total`,
  `symphony_agent_duration_milliseconds`).

### Per-plan-run usage

`GET /api/v1/plan-runs/:id/usage` aggregates `llm_calls` across all
sub-issues of a plan run (`tracker.getPlanRunUsage`):

```json
{
  "id": "RUN-…",
  "issue_count": 3,
  "total": { "attempts": 4, "input_tokens": 12000, "output_tokens": 3000, "cost_usd": 0.42 },
  "consistency": {
    "terminal_issues": 3,
    "done_issues": 2,
    "first_attempt_successes": 2,
    "first_attempt_success_rate": 0.67
  },
  "issues": [ { "issue_uuid": "…", "identifier": "TASK-1", "state": "done",
                "attempts": 1, "input_tokens": 4000, "output_tokens": 1000, "cost_usd": 0.14 } ]
}
```

The dashboard renders this as the **Usage & consistency** panel on each plan
run card in the issue detail view. No schema migration was required: the
aggregation joins the existing `issues.plan_run_id` and `llm_calls` tables.

Known limitation: `cost_usd` is only as complete as what agents report. The
nano adapter supplies it; adapters that do not report cost leave it null and
the totals undercount. Token counts are always recorded (payload first,
streamed accumulation as fallback).

## Reliability: pass@k and pass^k

Two complementary metrics from repeated sampling of the same task:

- **pass@k** — the probability that *at least one* of k independent runs
  succeeds. This is what retry-with-backoff exploits: even an unreliable
  agent converges to success if retried enough.
- **pass^k** — the probability that *all* k runs succeed. This measures
  consistency: can the loop be trusted when there is no retry safety net,
  e.g. unattended side effects that cannot simply be attempted again.

An orchestrator should optimize for the gap between the two. A large gap
(high pass@k, low pass^k) means the loop is propping up an unreliable harness
with retries — expensive and slow, and exactly the failure multiplication
that the harness-first ordering warns about.

What nano-symphony exposes today:

- Every attempt is recorded (`llm_calls` per attempt, `session_completed`
  events with semantics), so per-issue attempt counts and outcomes are
  reconstructable from the database.
- The plan-run usage endpoint above reports a pass@1-style consistency
  signal: `first_attempt_success_rate` is the share of terminal sub-issues
  that reached `done` on their first attempt, without retries.
- `issue_metrics.attempts` persists the attempt count for terminal issues,
  enabling offline pass@k estimation across the issue corpus.

What is **not** built yet: a dedicated endpoint that re-runs the same task k
times and computes empirical pass@k / pass^k. The data model supports it
(attempts and semantics are per-issue and append-only); computing it
faithfully requires deliberately scheduling k independent samples of
identical work, which is a product decision, not just a query.
