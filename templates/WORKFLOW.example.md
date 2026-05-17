---
tracker:
  type: local
agent:
  binary: nano
  timeout_ms: 300000
  max_retries: 3
  sandbox:
    backend: native           # native = bwrap (Linux) / sandbox-exec (macOS); 'docker' for stronger isolation; 'none' to disable
    network_access: true      # KEEP true — required for MCP callback to symphony
    extra_read_only_paths: [] # paths the agent's shell can read but not write, e.g. ["/Users/me/.gitconfig", "/Users/me/.ssh/known_hosts"]
    extra_writable_paths: []  # workspace is already writable; rarely needed
    docker_image: ubuntu:24.04 # only used when backend=docker
    # docker_runtime: runsc    # optional: use gVisor (runsc) or Kata Containers for stronger isolation with docker backend
goal:
  condition: "the issue is resolved and relevant checks pass"
  max_turns: 30
  inject_mode: prefix
  abort_on_max_turns: true
---
# Issue: {{ issue.identifier }} - {{ issue.title }}
{{ issue.description }}
Attempt: {{ attempt }}
