---
tracker:
  type: local
agent:
  binary: nano
  timeout_ms: 3600000        # 1 hour; tune down for fast trivial tasks
  max_retries: 3
  sandbox:
    backend: native           # native = bwrap (Linux) / sandbox-exec (macOS); 'docker' for stronger isolation; 'none' to disable
    network_access: true      # KEEP true — required for MCP callback to symphony
    extra_read_only_paths: [] # paths the agent's shell can read but not write, e.g. ["/Users/me/.gitconfig", "/Users/me/.ssh/known_hosts"]
    extra_writable_paths: []  # workspace is already writable; rarely needed
    docker_image: ubuntu:24.04 # only used when backend=docker
    # docker_runtime: runsc    # optional: use gVisor (runsc) or Kata Containers for stronger isolation with docker backend
workspace:
  root: ./workspaces
  # When true (default), symphony auto-runs `git init && git commit --allow-empty`
  # in managed workspaces so the handoff review panel can show a diff of agent
  # changes. External workspaces (issues with workspace_path set) are never
  # auto-initialized.
  git_baseline: true
  hooks:
    after_create: ""
    before_run: ""
    after_run: ""
    before_remove: ""
goal:
  condition: "the issue is resolved and relevant checks pass"
  max_turns: 30
  inject_mode: prefix
  abort_on_max_turns: true
---
# Issue: {{ issue.identifier }} - {{ issue.title }}
{{ issue.description }}
Attempt: {{ attempt }}
