#!/usr/bin/env bash
# Mock agent that mimics what real `nano` would do when invoked by nano-symphony's spawner.
# It speaks standard MCP JSON-RPC over HTTP via curl, and parses `.nano.yaml` using awk.
set -euo pipefail

############################################
# Phase 0: Parse CLI args (mirror spawner)
############################################
# spawner invokes: <bin> binary exec and sends prompt on stdin
MODE="${1:-}"
SUBCOMMAND="${2:-}"
PROMPT="$(cat)"

log() { echo "[mock-agent] $*"; }

log "started pid=$$ cwd=$(pwd)"
log "argv: mode=$MODE subcommand=$SUBCOMMAND prompt_bytes=${#PROMPT}"

if [[ "$MODE" != "binary" || "$SUBCOMMAND" != "exec" ]]; then
  log "unexpected command: $MODE $SUBCOMMAND (expected binary exec)"
  exit 64
fi

############################################
# Phase 1: Resolve MCP endpoint
############################################
YAML_URL=$(awk '/^[[:space:]]*url:/{gsub(/[" ]/,"",$2); print $2; exit}' .nano.yaml 2>/dev/null || true)
YAML_TOKEN=$(awk '/X-Symphony-Token:/{gsub(/[" ]/,"",$2); print $2; exit}' .nano.yaml 2>/dev/null || true)
log ".nano.yaml: url=$YAML_URL token=${YAML_TOKEN:0:8}..."

URL="${SYMPHONY_MCP_URL:-$YAML_URL}"
TOKEN="${SYMPHONY_TOKEN:-$YAML_TOKEN}"
: "${URL:?missing MCP URL (env SYMPHONY_MCP_URL or .nano.yaml)}"
: "${TOKEN:?missing token (env SYMPHONY_TOKEN or .nano.yaml)}"

log "SYMPHONY_ISSUE_ID=${SYMPHONY_ISSUE_ID:-}"
log "SYMPHONY_ATTEMPT=${SYMPHONY_ATTEMPT:-}"
log "SYMPHONY_WORKSPACE=${SYMPHONY_WORKSPACE:-}"
log "resolved MCP url=$URL"

############################################
# Phase 2: MCP JSON-RPC helper
############################################
RPC_ID=0

rpc() { # method, params_json
  RPC_ID=$((RPC_ID + 1))
  local method="$1"
  local params_json="$2"
  local body
  body=$(printf '{"jsonrpc":"2.0","id":%d,"method":"%s","params":%s}' "$RPC_ID" "$method" "$params_json")

  log "→ $method $params_json"
  local resp
  resp=$(curl -sS -X POST "$URL" \
    -H 'content-type: application/json' \
    -H "X-Symphony-Token: $TOKEN" \
    --max-time 10 \
    -d "$body")
  log "← $resp"

  if echo "$resp" | grep -q '"error"[[:space:]]*:'; then
    log "RPC error on $method"
    return 1
  fi
  echo "$resp"
}

############################################
# Phase 3: Standard MCP handshake
############################################
rpc "initialize" '{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"mock-agent","version":"0.1.0"}}' >/dev/null
TOOLS_RESP=$(rpc "tools/list" '{}')
echo "$TOOLS_RESP" | grep -q 'symphony.fetch_issue' || { log "tools/list missing symphony.fetch_issue"; exit 2; }
echo "$TOOLS_RESP" | grep -q 'symphony.session_completed' || { log "tools/list missing symphony.session_completed"; exit 2; }

############################################
# Phase 4: Symphony workflow
############################################
FETCH=$(rpc "tools/call" '{"name":"symphony.fetch_issue","arguments":{}}')
if [[ -n "${SYMPHONY_ISSUE_ID:-}" ]]; then
  echo "$FETCH" | grep -q "$SYMPHONY_ISSUE_ID" || { log "fetched issue id mismatch"; exit 3; }
fi

if [[ -n "${MOCK_FAIL_FETCH:-}" ]]; then
  log "injecting bad-token call"
  curl -sS -X POST "$URL" \
    -H 'content-type: application/json' \
    -H 'X-Symphony-Token: BAD' \
    --max-time 10 \
    -d '{"jsonrpc":"2.0","id":99,"method":"tools/call","params":{"name":"symphony.fetch_issue","arguments":{}}}' || true
  echo
fi

rpc "tools/call" '{"name":"symphony.report_event","arguments":{"kind":"progress","message":"mock halfway","payload":{"step":1}}}' >/dev/null

if [[ -n "${MOCK_SLEEP_BEFORE_COMPLETE:-}" ]]; then
  log "sleeping ${MOCK_SLEEP_BEFORE_COMPLETE}s before completion"
  sleep "$MOCK_SLEEP_BEFORE_COMPLETE"
fi

if [[ -n "${MOCK_SKIP_COMPLETE:-}" ]]; then
  log "MOCK_SKIP_COMPLETE=1 → exiting without symphony.session_completed"
  exit 0
fi

SEMANTICS="${MOCK_SEMANTICS:-success}"
rpc "tools/call" "$(printf '{"name":"symphony.session_completed","arguments":{"semantics":"%s","summary":"mock done","handoff_state":"in_review"}}' "$SEMANTICS")" >/dev/null
log "finished semantics=$SEMANTICS"

############################################
# Phase 5: Emit sentinel
############################################
# Real nano-agent emits a sentinel with status and optional goal_state.
# Only success should mark goal_state as achieved.
# For abandoned/needs_retry, we leave achieved_at null.
# Emit sentinel to stdout (protocol requirement)
# Use ISO-8601 timestamp for achieved_at when status=success
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "2024-01-01T00:00:00Z")
if [[ "$SEMANTICS" == "success" ]]; then
  printf '<<<NANO_RESULT>>>{"status":"success","goal_state":{"condition":"mock goal","achieved_at":"%s","last_reason":"mock done"}}\n' "$TIMESTAMP"
elif [[ "$SEMANTICS" == "handoff" ]]; then
  # For handoff, don't emit sentinel - let worker derive from MCP session_completed event with handoff_state
  :
elif [[ "$SEMANTICS" == "needs_retry" ]]; then
  printf '<<<NANO_RESULT>>>{"status":"needs_retry","goal_state":{"condition":"mock goal","achieved_at":null,"last_reason":"mock retry"}}\n'
elif [[ "$SEMANTICS" == "abandoned" ]]; then
  printf '<<<NANO_RESULT>>>{"status":"abandoned","goal_state":{"condition":"mock goal","achieved_at":null,"last_reason":"mock abandoned"}}\n'
else
  printf '<<<NANO_RESULT>>>{"status":"success","goal_state":{"condition":"mock goal","achieved_at":"%s","last_reason":"mock done"}}\n' "$TIMESTAMP"
fi

exit 0
