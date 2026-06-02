/**
 * Event Kind Registry — canonical list of all event kinds used by the symphony
 * event system. Introduced as a type-only definition first; tracker.recordEvent
 * still accepts `string` to avoid a breaking migration. New code should use
 * EventKind for compile-time safety.
 */
export const EVENT_KINDS = {
  // Lifecycle
  started: "Agent spawn started",
  completed: "Agent completed successfully",
  abandoned: "Agent abandoned or max retries exceeded",
  handoff: "Agent handed off to reviewer",

  // Progress
  prompt_rendered: "Prompt rendered for agent",
  comments_injected: "Operator comments injected into prompt",
  tool_call: "Agent made a tool call",
  assistant_chunk: "Agent produced text output",

  // Goal
  goal_evaluated: "Goal evaluator ran (not achieved)",
  goal_achieved: "Goal condition achieved",
  goal_max_turns: "Goal max turns reached",
  goal_state_observed: "Agent reported goal state",

  // Completion signals
  session_completed: "Agent called session_completed MCP tool",
  no_result_payload: "Agent exited without result payload",
  patch_collected: "Solution patch collected from outputDir",
  artifacts_collected: "Artifacts persisted to DB",

  // Sandbox & permissions
  sandbox_observed: "Sandbox metadata recorded",
  agent_blocked_commands: "Agent reported blocked commands",
  retrigger_suggestion: "Suggested configuration change before retrigger",

  // Retry & state
  retry_scheduled: "Retry scheduled with backoff",
  shortcircuit_same_cause: "Same blocker repeated, skipping retry",
  state_transition_suggested: "Agent suggested state change",

  // Plan review lifecycle
  plan_submitted: "Agent submitted implementation plan",
  plan_approved: "Plan approved by operator",
  plan_revision_requested: "Operator requested plan revision",

  // Operator actions
  retrigger_requested: "Operator requested retrigger",
  revision_requested: "Reviewer requested changes",
  approved: "Reviewer approved",
  comment_added: "Comment added to issue",
  comment_deleted: "Comment deleted",
  issue_created: "Child issue created",
  issue_activated: "Issue activated for scheduling",

  // System
  error: "Error occurred",
  workflow_reloaded: "Workflow file reloaded",
  workflow_reload_failed: "Workflow reload failed",
} as const;

export type EventKind = keyof typeof EVENT_KINDS;
