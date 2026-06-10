const BASE = "/api/v1";
export interface Issue { id: number; uuid: string; identifier: string; title: string; description: string | null; priority: string; state: string; branch: string | null; url: string | null; workspace_path: string | null; agent_kind: "nano" | "claude-code" | null; require_plan: boolean | null; created_at: string; updated_at: string; labels: string[]; blockers: Array<{ blocker_uuid: string; blocker_state: string }>; }
export interface SymphonyRun { issue_uuid: string; next_attempt: number; current_attempt: number | null; last_state: string; workspace_path: string; workspace_managed: boolean; next_due_ts: number | null; last_event: string | null; last_event_ts: number | null; last_error: string | null; token_input: number; token_output: number; token_total: number; }
export interface SymphonyEvent { id: string; issue_uuid: string; ts: number; kind: string; message: string; payload_json: string | null; }
export interface Comment { id: string; issue_uuid: string; ts: number; author: string; body: string; metadata: unknown | null; }
export interface Artifact { id: string; issue_uuid: string; attempt: number; source: "git_diff"; kind: string; label: string | null; path: string | null; content: string | null; metadata_json: string | null; content_size: number; mime_type: string; ts: number; }
export interface PlanRun { id: string; caller_issue_uuid: string | null; script: string; meta: string; args: string | null; state: string; dry_run_summary: string | null; approval_status: string | null; approval_reason: string | null; approved_at: number | null; approved_by: string | null; result: string | null; wall_time_ms: number; started_at: number | null; created_at: number; finished_at: number | null; }

/** S1: Read the token injected by the server into index.html at serve time. */
function getApiToken(): string | undefined {
  return (typeof window !== "undefined" ? (window as Record<string, unknown>).__SYMPHONY_API_TOKEN__ : undefined) as string | undefined;
}

/** Build auth headers for regular fetch requests. */
function authHeaders(): Record<string, string> {
  const token = getApiToken();
  return token ? { "Authorization": "Bearer " + token } : {};
}

/** Append ?token=<tok> to a URL for use with EventSource (which cannot set headers). */
function withTokenParam(url: string): string {
  const token = getApiToken();
  if (!token) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

// Unified request helper with proper error handling
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const merged: RequestInit = {
    ...init,
    headers: {
      ...authHeaders(),
      ...(init?.headers as Record<string, string> | undefined),
    },
  };
  const r = await fetch(url, merged);
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try {
      const body = await r.json();
      if (body.error && typeof body.error === "string") {
        msg = body.error;
      }
    } catch {}
    throw new Error(msg);
  }
  if (r.status === 204) {
    return undefined as T;
  }
  return r.json();
}

// Helper to create JSON request init
function jsonInit(method: string, body?: unknown): RequestInit {
  const init: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return init;
}

export const api = {
  async getHealth(): Promise<{ available_agents: string[]; [key: string]: unknown }> {
    return request(`${BASE}/health`);
  },
  async listIssues(state?: string): Promise<Issue[]> { const url = state ? `${BASE}/issues?state=${encodeURIComponent(state)}` : `${BASE}/issues`; return request<Issue[]>(url); },
  async getIssue(uuid: string): Promise<Issue> { return request<Issue>(`${BASE}/issues/${uuid}`); },
  async createIssue(data: Partial<Issue>): Promise<Issue> { return request<Issue>(`${BASE}/issues`, jsonInit("POST", data)); },
  async updateIssue(uuid: string, data: Partial<Issue>): Promise<Issue> { return request<Issue>(`${BASE}/issues/${uuid}`, jsonInit("PUT", data)); },
  async deleteIssue(uuid: string): Promise<void> { await request<void>(`${BASE}/issues/${uuid}`, { method: "DELETE" }); },
  async getRuns(): Promise<SymphonyRun[]> { return request<SymphonyRun[]>(`${BASE}/runs`); },
  async getRun(issueUuid: string): Promise<SymphonyRun> { return request<SymphonyRun>(`${BASE}/runs/${issueUuid}`); },
  async getEvents(since?: number): Promise<SymphonyEvent[]> { return request<SymphonyEvent[]>(since ? `${BASE}/events?since=${since}` : `${BASE}/events`); },
  async cancelRun(issueUuid: string): Promise<void> { await request<void>(`${BASE}/runs/${issueUuid}/cancel`, jsonInit("POST")); },
  async pauseRun(issueUuid: string): Promise<void> { await request<void>(`${BASE}/runs/${issueUuid}/pause`, jsonInit("POST")); },
  async resumeRun(issueUuid: string): Promise<void> { await request<void>(`${BASE}/runs/${issueUuid}/resume`, jsonInit("POST")); },
  async getWorkflow(): Promise<{ content: string }> { return request<{ content: string }>(`${BASE}/workflow`); },
  async saveWorkflow(content: string): Promise<void> { await request<void>(`${BASE}/workflow`, jsonInit("PUT", { content })); },
  streamEvents(): EventSource { return new EventSource(withTokenParam(`${BASE}/events/stream`)); },
  streamLogs(issueUuid: string, attempt: number): EventSource { return new EventSource(withTokenParam(`${BASE}/logs/${issueUuid}/${attempt}`)); },
  async getHandoff(issueUuid: string): Promise<unknown> { return request<unknown>(`${BASE}/issues/${issueUuid}/handoff`); },
  async approveHandoff(issueUuid: string, note?: string): Promise<void> { await request<void>(`${BASE}/issues/${issueUuid}/approve`, jsonInit("POST", { note })); },
  async requestChanges(issueUuid: string, note: string): Promise<void> { await request<void>(`${BASE}/issues/${issueUuid}/request-changes`, jsonInit("POST", { note })); },
  async getPlan(issueUuid: string): Promise<{ payload: { markdown?: string; revision?: number; estimates?: Record<string, unknown> } } | null> {
    try { return await request<{ payload: { markdown?: string; revision?: number; estimates?: Record<string, unknown> } }>(`${BASE}/issues/${issueUuid}/plan`); }
    catch { return null; }
  },
  async approvePlan(issueUuid: string, note?: string): Promise<{ ok: boolean; state: string }> { return request<{ ok: boolean; state: string }>(`${BASE}/issues/${issueUuid}/approve-plan`, jsonInit("POST", { note })); },
  async revisePlan(issueUuid: string, note: string): Promise<{ ok: boolean; state: string }> { return request<{ ok: boolean; state: string }>(`${BASE}/issues/${issueUuid}/revise-plan`, jsonInit("POST", { note })); },
  async revealWorkspace(issueUuid: string): Promise<{ ok: boolean; path: string }> { return request<{ ok: boolean; path: string }>(`${BASE}/issues/${issueUuid}/reveal-workspace`, jsonInit("POST")); },
  fileURL(issueUuid: string, relativePath: string): string { return withTokenParam(`${BASE}/workspaces/${issueUuid}/file?path=${encodeURIComponent(relativePath)}`); },
  async listComments(issueUuid: string): Promise<Comment[]> { return request<Comment[]>(`${BASE}/issues/${issueUuid}/comments`); },
  async addComment(issueUuid: string, body: string, author?: string): Promise<Comment> { return request<Comment>(`${BASE}/issues/${issueUuid}/comments`, jsonInit("POST", { body, author })); },
  async deleteComment(issueUuid: string, commentId: string): Promise<void> { await request<{ ok: boolean }>(`${BASE}/issues/${issueUuid}/comments/${commentId}`, { method: "DELETE" }); },
  async retrigger(issueUuid: string, opts?: { target_state?: string; note?: string }): Promise<void> { await request<{ ok: boolean }>(`${BASE}/issues/${issueUuid}/retrigger`, jsonInit("POST", opts ?? {})); },
  async listArtifacts(issueUuid: string, attempt?: number): Promise<Artifact[]> { const url = attempt !== undefined ? `${BASE}/issues/${issueUuid}/artifacts?attempt=${attempt}` : `${BASE}/issues/${issueUuid}/artifacts`; return request<Artifact[]>(url); },
  async listRecentArtifacts(limit?: number): Promise<Artifact[]> { const url = limit ? `${BASE}/artifacts?limit=${limit}` : `${BASE}/artifacts`; return request<Artifact[]>(url); },
  async getArtifact(id: string): Promise<Artifact> { return request<Artifact>(`${BASE}/artifacts/${id}`); },
  artifactRawURL(id: string): string { return `${BASE}/artifacts/${id}/raw`; },
  async listPlanRuns(callerIssueUuid?: string): Promise<PlanRun[]> {
    const url = callerIssueUuid ? `${BASE}/plan-runs?caller_issue_uuid=${encodeURIComponent(callerIssueUuid)}` : `${BASE}/plan-runs`;
    return request<PlanRun[]>(url);
  },
  async getPlanRun(id: string): Promise<PlanRun> { return request<PlanRun>(`${BASE}/plan-runs/${id}`); },
  async approvePlanRun(id: string): Promise<{ ok: boolean; state: string; approval_status: string }> {
    return request<{ ok: boolean; state: string; approval_status: string }>(`${BASE}/plan-runs/${id}/approve`, jsonInit("POST"));
  },
  async rejectPlanRun(id: string, reason?: string): Promise<{ ok: boolean; state: string }> {
    return request<{ ok: boolean; state: string }>(`${BASE}/plan-runs/${id}/reject`, jsonInit("POST", { reason }));
  },
  async getPlanRunResult(id: string): Promise<{ id: string; state: string; result: string | null }> {
    return request<{ id: string; state: string; result: string | null }>(`${BASE}/plan-runs/${id}/result`);
  },
};
