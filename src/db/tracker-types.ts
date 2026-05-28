export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: string;
  state: string;
  branch: string | null;
  url: string | null;
  workspace_path: string | null;
  agent_kind: "nano" | "claude-code" | null;
  agent_binary: string | null;
  sandbox_mode: "default" | "off" | null;
  sandbox_extra_writable_paths: string[];
  sandbox_extra_read_only_paths: string[];
  sandbox_extra_denied_paths: string[];
  permission_mode_override: string | null;
  created_at: string;
  updated_at: string;
  labels: string[];
  blockers: Array<{ blocker_id: string; blocker_state: string }>;
}

export interface IssueInput {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  priority?: string;
  state: string;
  branch?: string | null;
  url?: string | null;
  workspace_path?: string | null;
  agent_kind?: "nano" | "claude-code" | null;
  agent_binary?: string | null;
  sandbox_mode?: "default" | "off" | null;
  sandbox_extra_writable_paths?: string[];
  sandbox_extra_read_only_paths?: string[];
  sandbox_extra_denied_paths?: string[];
  permission_mode_override?: string | null;
  labels?: string[];
}

export interface SymphonyRun {
  issue_id: string;
  next_attempt: number;
  current_attempt: number | null;
  last_state: string;
  last_issue_state: string;
  workspace_path: string;
  workspace_managed: boolean;
  next_due_ts: number | null;
  last_event: string | null;
  last_event_ts: number | null;
  last_error: string | null;
  token_input: number;
  token_output: number;
  token_total: number;
}

export interface SymphonyEvent {
  id: string;
  issue_id: string;
  ts: number;
  kind: string;
  message: string;
  payload_json: string | null;
}

export interface Comment {
  id: string;
  issue_id: string;
  ts: number;
  author: string;
  body: string;
  metadata: unknown | null;
}
