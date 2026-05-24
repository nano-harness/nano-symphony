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
    extra_read_only_paths: [] # paths the agent's shell can read but not write; spawner auto-injects platform defaults: macOS adds /opt/homebrew, /usr/local, /Library/Developer/CommandLineTools, /Applications/Xcode.app/Contents/Developer, ~/.local, ~/.bun, ~/.cargo, ~/.rustup; Linux adds /opt, ~/.local, ~/.bun, ~/.cargo, ~/.rustup, ~/.nvm, ~/.pyenv
    extra_writable_paths: []  # workspace is already writable; rarely needed
    docker_image: ubuntu:24.04 # only used when backend=docker
    # docker_runtime: runsc    # optional: use gVisor (runsc) or Kata Containers for stronger isolation with docker backend
  # Permission mode controls how tool calls are gated (requires nano-agent >= 0.x.x)
  # - auto (default): LLM-backed risk classifier auto-approves low-risk tools, blocks high-risk ones
  # - default: tool-by-tool confirmation required for write operations
  # - acceptEdits: auto-approve file edits but require confirmation for other risky tools
  # - yolo: auto-approve everything (legacy behavior, not recommended for production)
  # - plan: block all actions until user confirms execution plan
  permission_mode: auto
  # Optional: configure auto mode behavior (only used when permission_mode=auto)
  # permission_auto:
  #   backend: llm            # llm = LLM-backed classifier (recommended); fail_closed = block everything requiring approval
  #   model: claude-haiku-3-5 # optional: override LLM model for classifier (default: reuse agent's main model)
  #   confidence_threshold: 0.8 # block if classifier confidence < threshold (0.0-1.0, default 0.8)
  #   timeout_seconds: 5      # classifier timeout; fail-open to default mode on timeout
  #   cache_ttl_minutes: 30   # cache classifier decisions to reduce LLM calls
  #   # Trust declaration (the ONLY mechanism to pre-allow commands in auto mode).
  #   # Specifiers are interpreted by nano-agent (segment-level fast-path for compound commands).
  #   # allow_rules: ["Bash(vwsd *)", "Bash(sngs *)"]
  #   # Denial tracker thresholds; 0 means "use nano-agent defaults".
  #   # denial_max_consecutive: 0
  #   # denial_max_total: 0
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
