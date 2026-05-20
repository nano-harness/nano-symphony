const BASE = "/api/v1";
export interface Issue { id: string; identifier: string; title: string; description: string | null; priority: string; state: string; branch: string | null; url: string | null; workspace_path: string | null; created_at: string; updated_at: string; labels: string[]; blockers: Array<{ blocker_id: string; blocker_state: string }>; }
export interface SymphonyRun { issue_id: string; next_attempt: number; last_state: string; workspace_path: string; workspace_managed: boolean; next_due_ts: number | null; last_event: string | null; last_event_ts: number | null; last_error: string | null; token_input: number; token_output: number; token_total: number; }
export interface SymphonyEvent { id: string; issue_id: string; ts: number; kind: string; message: string; payload_json: string | null; }

// Unified request helper with proper error handling
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
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
function jsonInit(method: string, body?: any): RequestInit {
  const init: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return init;
}

export const api = {
  async listIssues(state?: string): Promise<Issue[]> { const url = state ? `${BASE}/issues?state=${encodeURIComponent(state)}` : `${BASE}/issues`; return request<Issue[]>(url); },
  async getIssue(id: string): Promise<Issue> { return request<Issue>(`${BASE}/issues/${id}`); },
  async createIssue(data: Partial<Issue>): Promise<Issue> { return request<Issue>(`${BASE}/issues`, jsonInit("POST", data)); },
  async updateIssue(id: string, data: Partial<Issue>): Promise<Issue> { return request<Issue>(`${BASE}/issues/${id}`, jsonInit("PUT", data)); },
  async deleteIssue(id: string): Promise<void> { await request<void>(`${BASE}/issues/${id}`, { method: "DELETE" }); },
  async getRuns(): Promise<SymphonyRun[]> { return request<SymphonyRun[]>(`${BASE}/runs`); },
  async getRun(issueId: string): Promise<SymphonyRun> { return request<SymphonyRun>(`${BASE}/runs/${issueId}`); },
  async getEvents(since?: number): Promise<SymphonyEvent[]> { return request<SymphonyEvent[]>(since ? `${BASE}/events?since=${since}` : `${BASE}/events`); },
  async cancelRun(issueId: string): Promise<void> { await request<void>(`${BASE}/runs/${issueId}/cancel`, jsonInit("POST")); },
  async pauseRun(issueId: string): Promise<void> { await request<void>(`${BASE}/runs/${issueId}/pause`, jsonInit("POST")); },
  async resumeRun(issueId: string): Promise<void> { await request<void>(`${BASE}/runs/${issueId}/resume`, jsonInit("POST")); },
  async getWorkflow(): Promise<{ content: string }> { return request<{ content: string }>(`${BASE}/workflow`); },
  async saveWorkflow(content: string): Promise<void> { await request<void>(`${BASE}/workflow`, jsonInit("PUT", { content })); },
  streamEvents(): EventSource { return new EventSource(`${BASE}/events/stream`); },
  streamLogs(issueId: string, attempt: number): EventSource { return new EventSource(`${BASE}/logs/${issueId}/${attempt}`); },
  async getHandoff(issueId: string): Promise<any> { return request<any>(`${BASE}/issues/${issueId}/handoff`); },
  async approveHandoff(issueId: string, note?: string): Promise<void> { await request<void>(`${BASE}/issues/${issueId}/approve`, jsonInit("POST", { note })); },
  async requestChanges(issueId: string, note: string): Promise<void> { await request<void>(`${BASE}/issues/${issueId}/request-changes`, jsonInit("POST", { note })); },
  async revealWorkspace(issueId: string): Promise<{ ok: boolean; path: string }> { return request<{ ok: boolean; path: string }>(`${BASE}/issues/${issueId}/reveal-workspace`, jsonInit("POST")); },
  fileURL(issueId: string, path: string): string { return `${BASE}/workspaces/${issueId}/file?path=${encodeURIComponent(path)}`; },
};
