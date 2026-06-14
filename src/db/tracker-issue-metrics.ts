import type { Database } from "bun:sqlite";

export interface IssueMetrics {
  issue_uuid: string;
  final_state: string;
  attempts: number;
  sessions: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
  blocked: number;
  recorded_at: number;
}

export function createIssueMetricsOps(db: Database) {
  const upsertStmt = db.prepare(`
    INSERT INTO issue_metrics
      (issue_uuid, final_state, attempts, sessions, cost_usd, input_tokens, output_tokens, duration_ms, blocked, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(issue_uuid) DO UPDATE SET
      final_state = excluded.final_state,
      attempts = excluded.attempts,
      sessions = excluded.sessions,
      cost_usd = excluded.cost_usd,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      duration_ms = excluded.duration_ms,
      blocked = excluded.blocked,
      recorded_at = excluded.recorded_at
  `);

  const getStmt = db.prepare(`SELECT * FROM issue_metrics WHERE issue_uuid = ?`);
  const listStmt = db.prepare(`SELECT * FROM issue_metrics ORDER BY recorded_at DESC`);
  const summaryStmt = db.prepare(`
    SELECT
      COUNT(*) AS total_issues,
      COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
      COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
      COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
      COALESCE(SUM(duration_ms), 0) AS total_duration_ms,
      SUM(CASE WHEN blocked = 1 THEN 1 ELSE 0 END) AS blocked_count
    FROM issue_metrics
  `);

  function recordIssueMetrics(
    issueUuid: string,
    deps: {
      getIssue: (uuid: string) => { state: string; uuid: string } | null;
      getRun: (uuid: string) => { current_attempt: number | null } | null;
      getEventsByKind: (uuid: string, kind: string) => Array<{ payload_json: string | null }>;
      getLlmCallSummary: (uuid: string) => {
        input_tokens: number;
        output_tokens: number;
        cost_usd: number;
        duration_ms: number;
        call_count: number;
      };
    },
  ): IssueMetrics {
    const issue = deps.getIssue(issueUuid);
    const run = deps.getRun(issueUuid);
    const summary = deps.getLlmCallSummary(issueUuid);
    const sessions = deps.getEventsByKind(issueUuid, "session_completed").length;
    const finalState = issue?.state ?? "unknown";
    const metrics: IssueMetrics = {
      issue_uuid: issueUuid,
      final_state: finalState,
      attempts: run?.current_attempt ?? 0,
      sessions,
      cost_usd: summary.cost_usd,
      input_tokens: summary.input_tokens,
      output_tokens: summary.output_tokens,
      duration_ms: summary.duration_ms,
      blocked: finalState === "blocked" ? 1 : 0,
      recorded_at: Date.now(),
    };
    upsertStmt.run(
      metrics.issue_uuid,
      metrics.final_state,
      metrics.attempts,
      metrics.sessions,
      metrics.cost_usd,
      metrics.input_tokens,
      metrics.output_tokens,
      metrics.duration_ms,
      metrics.blocked,
      metrics.recorded_at,
    );
    return metrics;
  }

  function getIssueMetrics(issueUuid: string): IssueMetrics | null {
    return (getStmt.get(issueUuid) as IssueMetrics | null) ?? null;
  }

  function listIssueMetrics(): IssueMetrics[] {
    return listStmt.all() as IssueMetrics[];
  }

  function getMetricsSummary(): {
    total_issues: number;
    total_cost_usd: number;
    total_input_tokens: number;
    total_output_tokens: number;
    total_duration_ms: number;
    blocked_count: number;
  } {
    return summaryStmt.get() as {
      total_issues: number;
      total_cost_usd: number;
      total_input_tokens: number;
      total_output_tokens: number;
      total_duration_ms: number;
      blocked_count: number;
    };
  }

  return { recordIssueMetrics, getIssueMetrics, listIssueMetrics, getMetricsSummary };
}
