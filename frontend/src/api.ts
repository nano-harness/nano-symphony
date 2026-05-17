const BASE = "/api/v1";
export interface Issue { id: string; identifier: string; title: string; description: string | null; priority: string; state: string; branch: string | null; url: string | null; created_at: string; updated_at: string; labels: string[]; blockers: Array<{ blocker_id: string; blocker_state: string }>; }
export interface SymphonyRun { issue_id: string; last_attempt: number; last_state: string; workspace_path: string; next_due_ts: number | null; last_event: string | null; last_event_ts: number | null; last_error: string | null; token_input: number; token_output: number; token_total: number; }
export interface SymphonyEvent { id: string; issue_id: string; ts: number; kind: string; message: string; payload_json: string | null; }
export const api = {
  async listIssues(state?: string): Promise<Issue[]> { const url = state ? `${BASE}/issues?state=${encodeURIComponent(state)}` : `${BASE}/issues`; return (await fetch(url)).json(); },
  async getIssue(id: string): Promise<Issue> { return (await fetch(`${BASE}/issues/${id}`)).json(); },
  async createIssue(data: Partial<Issue>): Promise<Issue> { return (await fetch(`${BASE}/issues`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })).json(); },
  async updateIssue(id: string, data: Partial<Issue>): Promise<Issue> { return (await fetch(`${BASE}/issues/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })).json(); },
  async getRuns(): Promise<SymphonyRun[]> { return (await fetch(`${BASE}/runs`)).json(); },
  async getEvents(since?: number): Promise<SymphonyEvent[]> { return (await fetch(since ? `${BASE}/events?since=${since}` : `${BASE}/events`)).json(); },
  async cancelRun(issueId: string): Promise<void> { await fetch(`${BASE}/runs/${issueId}/cancel`, { method: "POST" }); },
  async pauseRun(issueId: string): Promise<void> { await fetch(`${BASE}/runs/${issueId}/pause`, { method: "POST" }); },
  async resumeRun(issueId: string): Promise<void> { await fetch(`${BASE}/runs/${issueId}/resume`, { method: "POST" }); },
  async getWorkflow(): Promise<{ content: string }> { return (await fetch(`${BASE}/workflow`)).json(); },
  async saveWorkflow(content: string): Promise<void> { await fetch(`${BASE}/workflow`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }) }); },
  streamEvents(): EventSource { return new EventSource(`${BASE}/events/stream`); },
};
