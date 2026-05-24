import { EventEmitter } from "node:events";

export type RunPatch = {
  issue_id: string;
  last_state?: string;
  current_attempt?: number;
  next_attempt?: number;
  token_input?: number;
  token_output?: number;
  token_total?: number;
  workspace_path?: string;
  workspace_managed?: boolean;
  last_event?: string;
  last_event_ts?: number;
};

export const bus = new EventEmitter();
bus.setMaxListeners(0);
