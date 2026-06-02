const BASE = "/api/v1";
export interface Issue { id: string; identifier: string; title: string; description: string | null; priority: string; state: string; branch: string | null; url: string | null; workspace_path: string | null; agent_kind: "nano" | "claude-code" | null; created_at: string; updated_at: string; labels: string[]; blockers: Array<{ blocker_id: string; blocker_state: string }>; }
export interface SymphonyRun { issue_id: string; next_attempt: number; current_attempt: number | null; last_state: string; workspace_path: string; workspace_managed: boolean; next_due_ts: number | null; last_event: string | null; last_event_ts: number | null; last_error: string | null; token_input: number; token_output: number; token_total: number; }
export interface SymphonyEvent { id: string; issue_id: string; ts: number; kind: string; message: string; payload_json: string | null; }
export interface Comment { id: string; issue_id: string; ts: number; author: string; body: string; metadata: unknown | null; }
export interface Artifact { id: string; issue_id: string; attempt: number; source: "git_diff"; kind: string; label: string | null; path: string | null; content: string | null; metadata_json: string | null; content_size: number; mime_type: string; ts: number; }

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
  streamEvents(): EventSource { return new EventSource(withTokenParam(`${BASE}/events/stream`)); },
  streamLogs(issueId: string, attempt: number): EventSource { return new EventSource(withTokenParam(`${BASE}/logs/${issueId}/${attempt}`)); },
  async getHandoff(issueId: string): Promise<unknown> { return request<unknown>(`${BASE}/issues/${issueId}/handoff`); },
  async approveHandoff(issueId: string, note?: string): Promise<void> { await request<void>(`${BASE}/issues/${issueId}/approve`, jsonInit("POST", { note })); },
  async requestChanges(issueId: string, note: string): Promise<void> { await request<void>(`${BASE}/issues/${issueId}/request-changes`, jsonInit("POST", { note })); },
  async getPlan(issueId: string): Promise<{ payload: { markdown?: string; revision?: number; estimates?: Record<string, unknown> } } | null> {
    try { return await request<{ payload: { markdown?: string; revision?: number; estimates?: Record<string, unknown> } }>(`${BASE}/issues/${issueId}/plan`); }
    catch { return null; }
  },
  async approvePlan(issueId: string, note?: string): Promise<{ ok: boolean; state: string }> { return request<{ ok: boolean; state: string }>(`${BASE}/issues/${issueId}/approve-plan`, jsonInit("POST", { note })); },
  async revisePlan(issueId: string, note: string): Promise<{ ok: boolean; state: string }> { return request<{ ok: boolean; state: string }>(`${BASE}/issues/${issueId}/revise-plan`, jsonInit("POST", { note })); },
  async revealWorkspace(issueId: string): Promise<{ ok: boolean; path: string }> { return request<{ ok: boolean; path: string }>(`${BASE}/issues/${issueId}/reveal-workspace`, jsonInit("POST")); },
  fileURL(issueId: string, relativePath: string): string { return withTokenParam(`${BASE}/workspaces/${issueId}/file?path=${encodeURIComponent(relativePath)}`); },
  async listComments(issueId: string): Promise<Comment[]> { return request<Comment[]>(`${BASE}/issues/${issueId}/comments`); },
  async addComment(issueId: string, body: string, author?: string): Promise<Comment> { return request<Comment>(`${BASE}/issues/${issueId}/comments`, jsonInit("POST", { body, author })); },
  async deleteComment(issueId: string, commentId: string): Promise<void> { await request<{ ok: boolean }>(`${BASE}/issues/${issueId}/comments/${commentId}`, { method: "DELETE" }); },
  async retrigger(issueId: string, opts?: { target_state?: string; note?: string }): Promise<void> { await request<{ ok: boolean }>(`${BASE}/issues/${issueId}/retrigger`, jsonInit("POST", opts ?? {})); },
  async listArtifacts(issueId: string, attempt?: number): Promise<Artifact[]> { const url = attempt !== undefined ? `${BASE}/issues/${issueId}/artifacts?attempt=${attempt}` : `${BASE}/issues/${issueId}/artifacts`; return request<Artifact[]>(url); },
  async listRecentArtifacts(limit?: number): Promise<Artifact[]> { const url = limit ? `${BASE}/artifacts?limit=${limit}` : `${BASE}/artifacts`; return request<Artifact[]>(url); },
  async getArtifact(id: string): Promise<Artifact> { return request<Artifact>(`${BASE}/artifacts/${id}`); },
  artifactRawURL(id: string): string { return `${BASE}/artifacts/${id}/raw`; },
};
