---
tracker:
  type: local
agent:
  kind: nano
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
  # Permission mode controls how tool calls are gated (requires nano-agent >= 0.8.2)
  # - auto (default): LLM-backed risk classifier auto-approves low-risk tools, blocks high-risk ones
  # - default: tool-by-tool confirmation required for write operations
  # - acceptEdits: auto-approve file edits but require confirmation for other risky tools
  # - yolo: auto-approve everything (legacy behavior, not recommended for production)
  # - plan: block all actions until user confirms execution plan
  permission_mode: auto
  # Optional: fine-tune which tools are allowed or denied (nano-agent >= 0.8.2)
  # Note: NANO_DAEMON_CONFIRM_POLICY=allow is ineffective on nano-agent <= 0.8.1; use permissions.allow instead.
  permissions:
    allow: []                 # extra tool glob patterns to always allow, e.g. ["Bash(vwsd *)", "Bash(sngs *)"]
    deny: []                  # tool glob patterns to always deny
    denial_max_consecutive: 0 # 0 = unlimited; max consecutive denials before agent is blocked
    denial_max_total: 0       # 0 = unlimited; total denial budget across the session
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

## 强制启动序列

在执行任何其他操作之前，请严格按顺序执行以下步骤：

1. `symphony fetch-issue` —— 了解你的任务。
2. 查看 issue 详情并规划你的实现方案。
3. 开始工作。

在调用 `fetch-issue` 之前，不要调用 `discover_skills` 或任何其他工具。

# Issue: {{ issue.identifier }} - {{ issue.title }}

[English](./WORKFLOW.example.md)

{{ issue.description }}
尝试次数：{{ attempt }}
