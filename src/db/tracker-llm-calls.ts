import type { Database } from "bun:sqlite";
import { nanoid } from "nanoid";

export interface LlmCall {
  id: string;
  issue_uuid: string;
  attempt: number;
  provider: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  duration_ms: number | null;
  duration_api_ms: number | null;
  created_at: number;
}

export function createLlmCallOps(db: Database) {
  const insertStmt = db.prepare(`
    INSERT INTO llm_calls
      (id, issue_uuid, attempt, provider, model, input_tokens, output_tokens, cost_usd, duration_ms, duration_api_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const listByIssueStmt = db.prepare(`
    SELECT * FROM llm_calls WHERE issue_uuid = ? ORDER BY attempt ASC, created_at ASC
  `);

  const summaryByIssueStmt = db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cost_usd), 0) AS cost_usd,
      COALESCE(SUM(duration_ms), 0) AS duration_ms,
      COUNT(*) AS call_count
    FROM llm_calls
    WHERE issue_uuid = ?
  `);

  function recordLlmCall(call: Omit<LlmCall, "id" | "created_at">): LlmCall {
    const id = nanoid();
    const createdAt = Date.now();
    insertStmt.run(
      id,
      call.issue_uuid,
      call.attempt,
      call.provider ?? null,
      call.model ?? null,
      call.input_tokens ?? 0,
      call.output_tokens ?? 0,
      call.cost_usd ?? null,
      call.duration_ms ?? null,
      call.duration_api_ms ?? null,
      createdAt,
    );
    return { ...call, id, created_at: createdAt };
  }

  function listLlmCalls(issueUuid: string): LlmCall[] {
    return listByIssueStmt.all(issueUuid) as LlmCall[];
  }

  function getLlmCallSummary(issueUuid: string): {
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    duration_ms: number;
    call_count: number;
  } {
    return summaryByIssueStmt.get(issueUuid) as {
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
      duration_ms: number;
      call_count: number;
    };
  }

  return { recordLlmCall, listLlmCalls, getLlmCallSummary };
}
