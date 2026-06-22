#!/usr/bin/env bash
#
# nano-symphony installation script
# Usage: curl -sSL https://binary-releases.oss-cn-hangzhou.aliyuncs.com/symphony/install.sh | bash
#

set -euo pipefail

# Configuration
OSS_BASE_URL="https://binary-releases.oss-cn-hangzhou.aliyuncs.com/symphony"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/share/nano-symphony}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
BINARY_NAME="symphony"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper functions
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_step() {
    echo -e "${BLUE}[STEP]${NC} $1"
}

normalize_version() {
    local version="$1"
    version="${version#v}"
    printf '%s\n' "${version}"
}

# Check if bun is installed
check_bun() {
    if command -v bun &> /dev/null; then
        log_info "Found bun: $(bun --version)"
        return 0
    fi

    log_error "bun is not installed. nano-symphony requires bun to run."
    echo ""
    echo "Install bun:"
    echo "  curl -fsSL https://bun.sh/install | bash"
    echo ""
    echo "After installation, restart your shell and run this script again."
    exit 1
}

# Read the installed version from share/VERSION (bundle mode).
# Falls back to package.json for legacy source-mode installs during migration.
read_installed_version() {
    local version_file="${INSTALL_DIR}/share/VERSION"
    local pkg_file="${INSTALL_DIR}/package.json"
    if [ -f "${version_file}" ]; then
        cat "${version_file}"
    elif [ -f "${pkg_file}" ]; then
        bun -e "console.log(require('./package.json').version)" 2>/dev/null || true
    fi
}

# Remove source-mode files left behind by a previous install so a clean
# bundle extraction can proceed.  User data (.env, WORKFLOW.md, *.db,
# workspaces/) is never touched here.
cleanup_source_mode() {
    if [ -d "${INSTALL_DIR}/src" ] || [ -d "${INSTALL_DIR}/node_modules" ]; then
        log_info "Detected source-mode install. Cleaning up..."
        rm -rf \
            "${INSTALL_DIR}/src" \
            "${INSTALL_DIR}/node_modules" \
            "${INSTALL_DIR}/frontend" \
            "${INSTALL_DIR}/skills" \
            "${INSTALL_DIR}/templates" \
            "${INSTALL_DIR}/scripts" \
            "${INSTALL_DIR}/tests" \
            "${INSTALL_DIR}/package.json" \
            "${INSTALL_DIR}/bun.lock" \
            "${INSTALL_DIR}/bun.lockb" \
            "${INSTALL_DIR}/tsconfig.json" \
            "${INSTALL_DIR}/.env.example"
    fi
}

# Copy the bundled skill into agent-global skill directories so all
# agent sessions on this machine can pick it up immediately without
# needing a per-workspace sync.
install_skill_globally() {
    local skills_dir="${INSTALL_DIR}/share/skills"
    if [ ! -d "${skills_dir}" ]; then
        log_warn "skills directory missing at ${skills_dir}, skipping global skill install"
        return
    fi

    for skill_src in "${skills_dir}"/*; do
        [ -d "${skill_src}" ] || continue
        local skill_name
        skill_name="$(basename "${skill_src}")"

        local nano_dest="${HOME}/.nano/skills/${skill_name}"
        mkdir -p "${nano_dest}"
        cp -R "${skill_src}/." "${nano_dest}/"
        log_info "Installed ${skill_name} skill to ${nano_dest}"

        if [ -d "${HOME}/.claude" ]; then
            local claude_dest="${HOME}/.claude/skills/${skill_name}"
            mkdir -p "${claude_dest}"
            cp -R "${skill_src}/." "${claude_dest}/"
            log_info "Installed ${skill_name} skill to ${claude_dest}"
        fi
    done
}

# Download and install
install_symphony() {
    local version="${VERSION:-latest}"
    local archive_url
    if [ "${version}" = "latest" ]; then
        archive_url="${OSS_BASE_URL}/latest/nano-symphony.tar.gz"
    else
        local tag_version="${version}"
        case "${tag_version}" in
            v*) ;;
            *) tag_version="v${tag_version}" ;;
        esac
        archive_url="${OSS_BASE_URL}/releases/${tag_version}/nano-symphony-${tag_version#v}.tar.gz"
    fi

    # Check current version if already installed
    if [ -f "${INSTALL_DIR}/share/VERSION" ] || [ -f "${INSTALL_DIR}/package.json" ]; then
        current_version=$(cd "${INSTALL_DIR}" && read_installed_version 2>/dev/null || true)
        current_version_normalized=$(normalize_version "${current_version}")

        # If a specific version is requested and we're already at that version, skip
        if [ "${version}" != "latest" ] && [ -n "${current_version_normalized}" ] && [ "${current_version_normalized}" = "$(normalize_version "${version}")" ]; then
            log_info "nano-symphony is already at version ${current_version}."
            return 0
        fi

        # If latest is requested, check against published metadata
        if [ "${version}" = "latest" ] && [ -n "${current_version}" ]; then
            log_info "Checking for updates..."
            local meta_file
            meta_file=$(mktemp) || return 1
            local meta_url="${OSS_BASE_URL}/meta.json"
            if curl -fsSL "${meta_url}" -o "${meta_file}" 2>/dev/null; then
                latest_version=$(META_FILE="${meta_file}" bun -e 'const meta = await Bun.file(process.env.META_FILE).json(); console.log(meta.version ?? "");' 2>/dev/null || true)
                rm -f "${meta_file}"
                if [ -n "${latest_version}" ] && [ "${current_version_normalized}" = "$(normalize_version "${latest_version}")" ]; then
                    log_info "nano-symphony is already up to date (${current_version})."
                    return 0
                fi
            else
                rm -f "${meta_file}"
                log_warn "Failed to fetch update metadata, proceeding with installation"
            fi
        fi
    fi

    tmp_dir=$(mktemp -d)
    trap 'rm -rf "${tmp_dir}"' EXIT

    log_step "Installing nano-symphony ${version}..."

    # Download archive
    log_info "Downloading archive from ${archive_url}..."
    if ! curl -sSL -f "${archive_url}" -o "${tmp_dir}/nano-symphony.tar.gz"; then
        log_error "Failed to download archive from ${archive_url}"
        log_error "Please check your network connection and verify the version exists."
        exit 1
    fi

    # Download and verify checksum
    local checksum_url="${archive_url}.sha256"
    log_info "Downloading checksum..."
    if curl -sSL -f "${checksum_url}" -o "${tmp_dir}/nano-symphony.tar.gz.sha256"; then
        log_info "Verifying checksum..."
        (
            cd "${tmp_dir}"
            # Extract expected hash from .sha256 file (first field)
            expected_hash=$(awk '{print $1}' nano-symphony.tar.gz.sha256)

            # Calculate actual hash using available tool (sha256sum or shasum)
            if command -v sha256sum > /dev/null 2>&1; then
                actual_hash=$(sha256sum nano-symphony.tar.gz | awk '{print $1}')
            elif command -v shasum > /dev/null 2>&1; then
                actual_hash=$(shasum -a 256 nano-symphony.tar.gz | awk '{print $1}')
            else
                log_error "Neither sha256sum nor shasum found. Cannot verify checksum."
                exit 1
            fi

            # Compare hashes
            if [ "$expected_hash" = "$actual_hash" ]; then
                log_info "Checksum verified successfully"
            else
                log_error "Checksum verification failed"
                log_error "Expected: $expected_hash"
                log_error "Got:      $actual_hash"
                exit 1
            fi
        )
    else
        log_warn "Failed to download checksum, skipping verification"
    fi

    # Create install directory and remove any source-mode files
    mkdir -p "${INSTALL_DIR}"
    cleanup_source_mode

    # Extract archive; exclude user-config files so they survive updates.
    # Fresh-install initialization happens in the guards below.
    log_info "Extracting archive to ${INSTALL_DIR}..."
    tar -xzf "${tmp_dir}/nano-symphony.tar.gz" -C "${INSTALL_DIR}" \
        --exclude='WORKFLOW.md' --exclude='.env' --exclude='*.db' --exclude='workspaces'

    # Initialize configuration files if they don't exist
    if [ ! -f "${INSTALL_DIR}/.env" ]; then
        log_info "Creating default .env configuration..."
        # Generate a stable random API_TOKEN so the CLI wrapper can authenticate
        # and the server uses the same token across restarts instead of a new random
        # UUID each time.
        api_token="$(bun -e "console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex'))")"
        cat > "${INSTALL_DIR}/.env" << ENVEOF
PORT=4123
# Bind address — default is loopback only. Change to 0.0.0.0 to expose externally,
# but API_TOKEN MUST be set when HOST is non-loopback (symphony refuses to start otherwise).
HOST=127.0.0.1
# API_TOKEN — shared secret for dashboard and /api/v1/* endpoints.
# Always enforced. A random UUID is auto-generated if left unset,
# meaning the token changes on every restart. Set a stable value
# for local development to avoid stale dashboard tabs.
API_TOKEN=${api_token}
DB_PATH=./symphony.db
WORKFLOW_PATH=./WORKFLOW.md
WORKSPACE_ROOT=./workspaces
LOG_LEVEL=info
MAX_CONCURRENT_AGENTS=3
AGENT_TOKEN_TTL_MS=3600000
ORCHESTRATOR_TICK_MS=1000
ENVEOF
        chmod 600 "${INSTALL_DIR}/.env"
        log_info "Generated API_TOKEN — run 'symphony token' to view it."
    else
        log_warn ".env already exists, skipping initialization"
    fi

    if [ ! -f "${INSTALL_DIR}/WORKFLOW.md" ]; then
        log_info "Creating default WORKFLOW.md..."
        cp "${INSTALL_DIR}/share/templates/WORKFLOW.example.md" "${INSTALL_DIR}/WORKFLOW.md"
    else
        log_warn "WORKFLOW.md already exists, skipping initialization"
    fi

    # Install skill to agent-global directories
    install_skill_globally

    # Create wrapper script
    log_info "Creating ${BINARY_NAME} wrapper in ${BIN_DIR}..."
    mkdir -p "${BIN_DIR}"

    # Write the wrapper with a quoted heredoc so that command substitutions and
    # variable references inside the wrapper body are not evaluated by the
    # installer. We then substitute the real INSTALL_DIR and restore the escaped
    # ${...} references that the wrapper needs at runtime.
    cat > "${BIN_DIR}/${BINARY_NAME}" << 'EOF'
#!/usr/bin/env bash
# nano-symphony launcher
# Generated by install.sh

INSTALL_DIR="${INSTALL_DIR}"

if [ ! -d "\${INSTALL_DIR}" ]; then
    echo "Error: nano-symphony is not installed at \${INSTALL_DIR}"
    echo "Run the installer: curl -sSL https://binary-releases.oss-cn-hangzhou.aliyuncs.com/symphony/install.sh | bash"
    exit 2
fi

PORT="\${SYMPHONY_PORT:-\${PORT:-4123}}"
API_BASE="http://localhost:\${PORT}/api/v1"

# Load API_TOKEN from .env so all curl calls are authenticated.
# The server always enforces auth; without a token every request returns 401.
if [ -f "\${INSTALL_DIR}/.env" ]; then
  _api_token_entry="\$(grep -E '^API_TOKEN=' "\${INSTALL_DIR}/.env")"
  if [ -n "\${_api_token_entry}" ]; then
    # shellcheck disable=SC2046
    export \$(printf '%s' "\${_api_token_entry}" | xargs) 2>/dev/null || true
  fi
  unset _api_token_entry
fi
# Token selection:
# - In agent context (SYMPHONY_ISSUE_UUID is set) the spawner has already injected
#   the agent-scoped SYMPHONY_TOKEN. Keep it and do NOT fall back to API_TOKEN.
# - In admin context use API_TOKEN from .env, with SYMPHONY_TOKEN as an override.
if [ -z "\${SYMPHONY_ISSUE_UUID:-}" ]; then
  SYMPHONY_TOKEN="\${SYMPHONY_TOKEN:-\${API_TOKEN:-}}"
fi

# In CLI-first mode the spawner clears SYMPHONY_MCP_URL/SYMPHONY_TOKEN from the
# agent environment and writes them to .symphony/env in the workspace so nano
# cannot auto-discover the MCP server. Load them back when running inside an
# agent session.
# We search upward from the current directory so the agent can call `symphony`
# from any subdirectory of the workspace. If SYMPHONY_WORKSPACE is set (e.g. the
# spawner overrode the issue workspace_path), trust it first so custom
# workspaces still work even if the current directory is not inside them.
load_workspace_env() {
  if [ -n "\${SYMPHONY_MCP_URL:-}" ]; then
    return
  fi
  local start_dir="\${SYMPHONY_WORKSPACE:-\${PWD}}"
  local dir="\${start_dir}"
  while [ "\${dir}" != "/" ]; do
    if [ -f "\${dir}/.symphony/env" ]; then
      # shellcheck disable=SC2046
      export \$(grep -v '^#' "\${dir}/.symphony/env" | xargs) 2>/dev/null || true
      return
    fi
    dir="\$(dirname "\${dir}")"
  done
}
load_workspace_env

# Now that the workspace env (if any) is loaded, switch to the install directory
# so admin commands can locate bundled assets.
cd "\${INSTALL_DIR}"

# Helper: curl with optional auth header injected
curl_api() {
  if [ -n "\${SYMPHONY_TOKEN}" ]; then
    curl -H "X-Symphony-Token: \${SYMPHONY_TOKEN}" "\$@"
  else
    curl "\$@"
  fi
}

# Helper: call an MCP tool via JSON-RPC. Reads SYMPHONY_MCP_URL and SYMPHONY_TOKEN.
agent_api_call() {
  local tool_name="\$1"
  # Bash parameter-default syntax cannot safely include literal '{}', so we
  # branch explicitly when the second argument is missing.
  local args_json
  if [ -n "\${2:-}" ]; then
    args_json="\$2"
  else
    args_json="{}"
  fi
  local mcp_url="\${SYMPHONY_MCP_URL:-}"
  local token="\${SYMPHONY_TOKEN:-}"
  if [ -z "\${mcp_url}" ]; then
    echo "Error: SYMPHONY_MCP_URL is not set. Is this running inside a Symphony agent session?" >&2
    return 1
  fi
  if [ -z "\${token}" ]; then
    echo "Error: SYMPHONY_TOKEN is not set." >&2
    return 1
  fi
  local req_id
  req_id="\$(date +%s%N 2>/dev/null || echo "\$RANDOM")"
  local payload
  payload="{\"jsonrpc\":\"2.0\",\"id\":\"\${req_id}\",\"method\":\"tools/call\",\"params\":{\"name\":\"\${tool_name}\",\"arguments\":\${args_json}}}"
  curl -fsS -X POST "\${mcp_url}" \
    -H 'Content-Type: application/json' \
    -H "X-Symphony-Token: \${token}" \
    -d "\${payload}"
}

# Helper: JSON-encode a plain string using node (available on macOS and most Linux).
json_string() {
  node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "\$1" 2>/dev/null || printf '"%s"' "\$1"
}

# Helper: pretty-print JSON if stdin is valid JSON, otherwise pass through.
print_json() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -m json.tool 2>/dev/null || cat
  else
    cat
  fi
}

if [ ! -d "\${INSTALL_DIR}" ]; then
    echo "Error: nano-symphony is not installed at \${INSTALL_DIR}"
    echo "Run the installer: curl -sSL https://binary-releases.oss-cn-hangzhou.aliyuncs.com/symphony/install.sh | bash"
    exit 2
fi

cd "\${INSTALL_DIR}"

# Generated wrapper must carry its own helpers after installation.
normalize_version() {
  version="\$1"
  version="\${version#v}"
  printf '%s\n' "\${version}"
}

print_help() {
  cat <<HLP
nano-symphony — coding agent orchestration service

USAGE
  symphony <command> [args...]

COMMANDS
  start              Start backend service (foreground). Exit 0 on clean shutdown.
  status             Probe http://localhost:\${PORT}/api/v1/health. Exit 0 if up, 1 if down.
  token              Print the current API token (from .env or environment).
  update [version]   Read OSS metadata and update nano-symphony (default: latest).
  version            Print version (from \${INSTALL_DIR}/share/VERSION).
  issue list [state] List issues (HTTP GET /api/v1/issues).
  issue get <id>     Get issue (HTTP GET /api/v1/issues/:id).
  issue create <title> [--priority=...] [--state=...]
                     Create issue via HTTP POST /api/v1/issues. Default state: todo.
  help, --help, -h   Print this message.

AGENT COMMANDS (run inside an agent session; use SYMPHONY_TOKEN/MCP_URL from env)
  fetch-issue
  report-event --kind K --message M [--payload-json JSON]
  report-goal-state [--condition C] [--turns-evaluated N] [--max-turns N]
                    [--achieved-at A] [--last-reason R] [--tokens-json JSON]
  request-workflow-section [--section NAME]
  suggest-state-transition --state STATE --reason REASON
  emit-result --data-json JSON
  session-completed --semantics S [--summary TEXT] [--handoff-state H]
                      [--blocker-fingerprint F] [--termination-cause C]
                      [--artifacts-json JSON] [--follow-ups-json JSON]
  spawn-plan-run --script FILE --meta-json JSON [--args-json JSON]
  spawn-plan-run-and-handoff --script FILE --meta-json JSON [--args-json JSON]
  get-artifact --artifact-id ID [--mode MODE] [--lines N] [--bytes N] [--pattern P]
  list-related-artifacts
  update-issue-scratchpad --text TEXT

NOTE
  dev, build, test, lint subcommands are only available in source builds.
  For local development, use: SYMPHONY_SHARE_ROOT=\$(pwd) bun --watch src/index.ts

EXAMPLES
  symphony start
  symphony status
  symphony update
  symphony issue list todo
  symphony issue get <issue-id>
  symphony issue create "Investigate flaky test" --priority=high --state=todo

PATHS
  Install dir : \${INSTALL_DIR}
  Config      : \${INSTALL_DIR}/.env
  Workflow    : \${INSTALL_DIR}/WORKFLOW.md
  Database    : \${INSTALL_DIR}/symphony.db   (SQLite, persistent)
  Workspaces  : \${INSTALL_DIR}/workspaces
  Logs        : \${INSTALL_DIR}/workspaces/<uuid>/logs/attempt-<n>.log

ENDPOINTS  (defaults; override via PORT or SYMPHONY_PORT)
  HTTP API   : http://localhost:\${PORT}/api/v1
  MCP server : http://localhost:\${PORT}/mcp
  Dashboard  : http://localhost:\${PORT}

KEY REST PATHS
  GET    /api/v1/issues[?state=...]
  GET    /api/v1/issues/:uuid
  POST   /api/v1/issues       {title,state,...}
  PUT    /api/v1/issues/:uuid
  GET    /api/v1/runs
  GET    /api/v1/events[?since=ts]
  GET    /api/v1/events/stream  (SSE)
  POST   /api/v1/runs/:id/{cancel|pause|resume}
  GET    /api/v1/workflow
  PUT    /api/v1/workflow

MCP TOOLS  (callable via JSON-RPC at /mcp with X-Symphony-Token header)
  symphony.fetch_issue
  symphony.report_event
  symphony.request_workflow_section
  symphony.suggest_state_transition
  symphony.session_completed

ENVIRONMENT VARIABLES
  PORT                  4123       HTTP port
  SYMPHONY_PORT         4123       Wrapper HTTP port override
  API_TOKEN             (required) Control-plane auth token. Read from \${INSTALL_DIR}/.env or
                                   env. Use 'symphony token' to show the current value.
  SYMPHONY_TOKEN                   Alias for API_TOKEN accepted by the wrapper.
  DB_PATH               ./symphony.db
  WORKFLOW_PATH         ./WORKFLOW.md
  WORKSPACE_ROOT        ./workspaces
  LOG_LEVEL             info       trace|debug|info|warn|error|fatal
  MAX_CONCURRENT_AGENTS 3
  AGENT_TOKEN_TTL_MS    3600000
  ORCHESTRATOR_TICK_MS  1000

EXIT CODES
  0  success
  1  command failed (test/lint/status fail, HTTP error)
  2  install dir missing or unusable
  64 unknown subcommand or invalid usage
HLP
}

issue_usage() {
  echo "Usage: symphony issue {list [state]|get <id>|create <title> [--priority=...] [--state=...]}"
}

case "\${1:-}" in
  start)
    export SYMPHONY_SHARE_ROOT="\${INSTALL_DIR}/share"
    exec bun "\${INSTALL_DIR}/index.js" ;;
  dev|build|test|lint)
    echo "Subcommand '\${1}' is only available in source builds." >&2
    echo "For local development, use: SYMPHONY_SHARE_ROOT=\$(pwd) bun --watch src/index.ts" >&2
    exit 64 ;;
  status)
    # Probe /health (auth-exempt) instead of /runs so status works without a token
    # and also provides a reliable liveness signal even before any issues exist.
    if curl -fsS "\${API_BASE}/health" >/dev/null 2>&1; then
      echo "symphony: running on :\${PORT}"; exit 0
    else
      echo "symphony: NOT running on :\${PORT}"; exit 1
    fi ;;
  token)
    # Print the token the wrapper is currently using so operators can copy it.
    if [ -n "\${SYMPHONY_TOKEN}" ]; then
      echo "\${SYMPHONY_TOKEN}"
    else
      echo "No API_TOKEN found. Set API_TOKEN in \${INSTALL_DIR}/.env or via environment."
      exit 1
    fi ;;
  update)
    requested_version="\${2:-}"
    current_version="\$(cat "\${INSTALL_DIR}/share/VERSION" 2>/dev/null || true)"
    current_version_normalized="\$(normalize_version "\${current_version}")"

    # If a specific version is requested and we're already at that version, skip
    if [ -n "\${requested_version}" ] && [ -n "\${current_version_normalized}" ] && [ "\${current_version_normalized}" = "\$(normalize_version "\${requested_version}")" ]; then
      echo "nano-symphony is already at version \${current_version}."
      exit 0
    fi

    meta_file="\$(mktemp)" || exit 1
    meta_url="${OSS_BASE_URL}/meta.json"
    if ! curl -fsSL "\${meta_url}" -o "\${meta_file}"; then
      echo "Failed to download update metadata from \${meta_url}"
      rm -f "\${meta_file}"
      exit 1
    fi
    latest_version="\$(META_FILE="\${meta_file}" bun -e 'const meta = await Bun.file(process.env.META_FILE).json(); console.log(meta.version ?? "");')" || { rm -f "\${meta_file}"; exit 1; }
    install_url="\$(META_FILE="\${meta_file}" bun -e 'const meta = await Bun.file(process.env.META_FILE).json(); console.log(meta.install_script_url ?? "");')" || { rm -f "\${meta_file}"; exit 1; }
    rm -f "\${meta_file}"
    [ "\${latest_version}" ] || { echo "Update metadata is missing version"; exit 1; }
    [ "\${install_url}" ] || install_url="${OSS_BASE_URL}/install.sh"

    # If no specific version requested and we're already at latest, skip
    if [ -z "\${requested_version}" ] && [ -n "\${current_version_normalized}" ] && [ "\${current_version_normalized}" = "\$(normalize_version "\${latest_version}")" ]; then
      echo "nano-symphony is already up to date (\${current_version})."
      exit 0
    fi

    version="\${requested_version:-latest}"
    install_script="\$(mktemp)" || exit 1
    if curl -fsSL "\${install_url}" -o "\${install_script}"; then
      INSTALL_DIR="\${INSTALL_DIR}" BIN_DIR="${BIN_DIR}" VERSION="\${version}" bash "\${install_script}"
      rc="\$?"
    else
      echo "Failed to download installer from \${install_url}"
      rc=1
    fi
    rm -f "\${install_script}"
    [ "\${rc}" -eq 0 ] && echo "nano-symphony updated to \${requested_version:-\${latest_version}}. Restart any running symphony service to use the new version."
    exit "\${rc}" ;;
  version|--version|-v)
    cat "\${INSTALL_DIR}/share/VERSION" ;;
  issue)
    shift
    sub="\${1:-}"; shift || true
    case "\${sub}" in
      list)
        if [ "\${1:-}" ]; then
          curl_api -fsS "\${API_BASE}/issues?state=\$1"
        else
          curl_api -fsS "\${API_BASE}/issues"
        fi ;;
      get)
        [ "\${1:-}" ] || { issue_usage; exit 64; }
        curl_api -fsS "\${API_BASE}/issues/\$1" ;;
      create)
        [ "\${1:-}" ] || { issue_usage; exit 64; }
        title="\$1"; shift
        priority="medium"
        # Default to 'todo' (not 'backlog') so issues are picked up by the
        # orchestrator immediately.  'backlog' issues are filtered out by getCandidates
        # (src/db/tracker-issues.ts) and will never be dispatched.
        state="todo"
        while [ "\$#" -gt 0 ]; do
          case "\$1" in
            --priority=*) priority="\${1#--priority=}" ;;
            --state=*) state="\${1#--state=}" ;;
            *) echo "Unknown issue create option: \$1"; issue_usage; exit 64 ;;
          esac
          shift
        done
        title_json="\$(json_string "\${title}")"
        priority_json="\$(json_string "\${priority}")"
        state_json="\$(json_string "\${state}")"
        curl_api -fsS -X POST "\${API_BASE}/issues" \
          -H 'Content-Type: application/json' \
          -d "{\"title\":\${title_json},\"priority\":\${priority_json},\"state\":\${state_json},\"labels\":[]}" ;;
      *) issue_usage; exit 64 ;;
    esac ;;

  # ─── Agent commands: thin JSON-RPC wrappers around the MCP endpoint ─────────
  # These run inside an agent session and use SYMPHONY_MCP_URL / SYMPHONY_TOKEN
  # injected by the spawner. They call the existing /mcp JSON-RPC endpoint.
  fetch-issue)
    agent_api_call "symphony.fetch_issue" | print_json ;;

  report-event)
    shift
    kind=""
    message=""
    payload_json=""
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        --kind) kind="\${2:-}"; shift ;;
        --kind=*) kind="\${1#--kind=}" ;;
        --message) message="\${2:-}"; shift ;;
        --message=*) message="\${1#--message=}" ;;
        --payload-json) payload_json="\${2:-}"; shift ;;
        --payload-json=*) payload_json="\${1#--payload-json=}" ;;
        *) echo "Unknown report-event option: \$1" >&2; exit 64 ;;
      esac
      shift
    done
    [ -n "\${kind}" ] || { echo "Error: --kind is required" >&2; exit 64; }
    [ -n "\${message}" ] || { echo "Error: --message is required" >&2; exit 64; }
    parts="\"kind\":\$(json_string "\${kind}"),\"message\":\$(json_string "\${message}")"
    [ -n "\${payload_json}" ] && parts="\${parts},\"payload\":\${payload_json}"
    agent_api_call "symphony.report_event" "{\${parts}}" | print_json ;;

  report-goal-state)
    shift
    condition=""
    turns_evaluated=""
    max_turns=""
    achieved_at=""
    last_reason=""
    tokens_json=""
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        --condition=*) condition="\${1#--condition=}" ;;
        --turns-evaluated=*) turns_evaluated="\${1#--turns-evaluated=}" ;;
        --max-turns=*) max_turns="\${1#--max-turns=}" ;;
        --achieved-at=*) achieved_at="\${1#--achieved-at=}" ;;
        --last-reason=*) last_reason="\${1#--last-reason=}" ;;
        --tokens-json=*) tokens_json="\${1#--tokens-json=}" ;;
        *) echo "Unknown report-goal-state option: \$1" >&2; exit 64 ;;
      esac
      shift
    done
    parts=""
    [ -n "\${condition}" ] && parts="\${parts},\"condition\":\$(json_string "\${condition}")"
    [ -n "\${turns_evaluated}" ] && parts="\${parts},\"turns_evaluated\":\${turns_evaluated}"
    [ -n "\${max_turns}" ] && parts="\${parts},\"max_turns\":\${max_turns}"
    [ -n "\${achieved_at}" ] && parts="\${parts},\"achieved_at\":\$(json_string "\${achieved_at}")"
    [ -n "\${last_reason}" ] && parts="\${parts},\"last_reason\":\$(json_string "\${last_reason}")"
    [ -n "\${tokens_json}" ] && parts="\${parts},\"tokens\":\${tokens_json}"
    # Strip leading comma
    parts="\${parts#,}"
    agent_api_call "symphony.report_goal_state" "{\${parts}}" | print_json ;;

  request-workflow-section)
    shift
    section=""
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        --section=*) section="\${1#--section=}" ;;
        *) echo "Unknown request-workflow-section option: \$1" >&2; exit 64 ;;
      esac
      shift
    done
    if [ -n "\${section}" ]; then
      args="{\"section\":\$(json_string "\${section}")}"
    else
      args="{}"
    fi
    agent_api_call "symphony.request_workflow_section" "\${args}" | print_json ;;

  suggest-state-transition)
    shift
    state=""
    reason=""
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        --state=*) state="\${1#--state=}" ;;
        --reason=*) reason="\${1#--reason=}" ;;
        *) echo "Unknown suggest-state-transition option: \$1" >&2; exit 64 ;;
      esac
      shift
    done
    [ -n "\${state}" ] || { echo "Error: --state is required" >&2; exit 64; }
    [ -n "\${reason}" ] || { echo "Error: --reason is required" >&2; exit 64; }
    args="{\"suggested_state\":\$(json_string "\${state}"),\"reason\":\$(json_string "\${reason}")}"
    agent_api_call "symphony.suggest_state_transition" "\${args}" | print_json ;;

  emit-result)
    shift
    data_json=""
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        --data-json|--data)
          data_json="\${2:-}"
          shift ;;
        --data-json=*|--data=*)
          data_json="\${1#*=}" ;;
        *) echo "Unknown emit-result option: \$1" >&2; exit 64 ;;
      esac
      shift
    done
    [ -n "\${data_json}" ] || { echo "Error: --data-json is required" >&2; exit 64; }
    # If data_json is already valid JSON, embed it directly so objects/arrays reach the server as structured data.
    if node -e 'JSON.parse(process.argv[1]); process.stdout.write("ok")' "\${data_json}" >/dev/null 2>&1; then
      args="{\"data\":\${data_json}}"
    else
      args="{\"data\":\$(json_string "\${data_json}")}"
    fi
    agent_api_call "symphony.emit_result" "\${args}" | print_json ;;

  session-completed)
    shift
    semantics=""
    summary=""
    handoff_state=""
    blocker_fingerprint=""
    termination_cause=""
    artifacts_json=""
    follow_ups_json=""
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        --semantics) semantics="\${2:-}"; shift ;;
        --semantics=*) semantics="\${1#*=}" ;;
        --summary) summary="\${2:-}"; shift ;;
        --summary=*) summary="\${1#*=}" ;;
        --handoff-state) handoff_state="\${2:-}"; shift ;;
        --handoff-state=*) handoff_state="\${1#*=}" ;;
        --blocker-fingerprint) blocker_fingerprint="\${2:-}"; shift ;;
        --blocker-fingerprint=*) blocker_fingerprint="\${1#*=}" ;;
        --termination-cause) termination_cause="\${2:-}"; shift ;;
        --termination-cause=*) termination_cause="\${1#*=}" ;;
        --artifacts-json) artifacts_json="\${2:-}"; shift ;;
        --artifacts-json=*) artifacts_json="\${1#*=}" ;;
        --follow-ups-json) follow_ups_json="\${2:-}"; shift ;;
        --follow-ups-json=*) follow_ups_json="\${1#*=}" ;;
        *) echo "Unknown session-completed option: \$1" >&2; exit 64 ;;
      esac
      shift
    done
    [ -n "\${semantics}" ] || { echo "Error: --semantics is required" >&2; exit 64; }
    parts="\"semantics\":\$(json_string "\${semantics}")"
    [ -n "\${summary}" ] && parts="\${parts},\"summary\":\$(json_string "\${summary}")"
    [ -n "\${handoff_state}" ] && parts="\${parts},\"handoff_state\":\$(json_string "\${handoff_state}")"
    [ -n "\${blocker_fingerprint}" ] && parts="\${parts},\"blocker_fingerprint\":\$(json_string "\${blocker_fingerprint}")"
    [ -n "\${termination_cause}" ] && parts="\${parts},\"termination_cause\":\$(json_string "\${termination_cause}")"
    [ -n "\${artifacts_json}" ] && parts="\${parts},\"artifacts\":\${artifacts_json}"
    [ -n "\${follow_ups_json}" ] && parts="\${parts},\"follow_ups\":\${follow_ups_json}"
    agent_api_call "symphony.session_completed" "{\${parts}}" | print_json ;;

  spawn-plan-run|spawn-plan-run-and-handoff)
    cmd="\$1"
    shift
    script_file=""
    meta_json=""
    args_json=""
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        --script=*) script_file="\${1#--script=}" ;;
        --meta-json=*) meta_json="\${1#--meta-json=}" ;;
        --args-json=*) args_json="\${1#--args-json=}" ;;
        *) echo "Unknown \${cmd} option: \$1" >&2; exit 64 ;;
      esac
      shift
    done
    [ -n "\${script_file}" ] || { echo "Error: --script is required" >&2; exit 64; }
    [ -n "\${meta_json}" ] || { echo "Error: --meta-json is required" >&2; exit 64; }
    if [ "\${script_file}" = "-" ]; then
      script_content="\$(cat)"
    elif [ -f "\${script_file}" ]; then
      script_content="\$(cat "\${script_file}")"
    else
      echo "Error: script file not found: \${script_file}" >&2
      exit 64
    fi
    parts="\"script\":\$(json_string "\${script_content}"),\"meta\":\${meta_json}"
    [ -n "\${args_json}" ] && parts="\${parts},\"args\":\${args_json}"
    tool_name="symphony.spawn_plan_run"
    [ "\${cmd}" = "spawn-plan-run-and-handoff" ] && tool_name="symphony.spawn_plan_run_and_handoff"
    agent_api_call "\${tool_name}" "{\${parts}}" | print_json ;;

  get-artifact)
    shift
    artifact_id=""
    mode=""
    lines=""
    bytes=""
    pattern=""
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        --artifact-id=*) artifact_id="\${1#--artifact-id=}" ;;
        --mode=*) mode="\${1#--mode=}" ;;
        --lines=*) lines="\${1#--lines=}" ;;
        --bytes=*) bytes="\${1#--bytes=}" ;;
        --pattern=*) pattern="\${1#--pattern=}" ;;
        *) echo "Unknown get-artifact option: \$1" >&2; exit 64 ;;
      esac
      shift
    done
    [ -n "\${artifact_id}" ] || { echo "Error: --artifact-id is required" >&2; exit 64; }
    parts="\"artifact_id\":\$(json_string "\${artifact_id}")"
    [ -n "\${mode}" ] && parts="\${parts},\"mode\":\$(json_string "\${mode}")"
    [ -n "\${lines}" ] && parts="\${parts},\"lines\":\${lines}"
    [ -n "\${bytes}" ] && parts="\${parts},\"bytes\":\${bytes}"
    [ -n "\${pattern}" ] && parts="\${parts},\"pattern\":\$(json_string "\${pattern}")"
    agent_api_call "symphony.get_artifact" "{\${parts}}" | print_json ;;

  list-related-artifacts)
    agent_api_call "symphony.list_related_artifacts" "{}" | print_json ;;

  update-issue-scratchpad)
    shift
    text=""
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        --text=*) text="\${1#--text=}" ;;
        *) echo "Unknown update-issue-scratchpad option: \$1" >&2; exit 64 ;;
      esac
      shift
    done
    [ -n "\${text}" ] || { echo "Error: --text is required" >&2; exit 64; }
    args="{\"text\":\$(json_string "\${text}")}"
    agent_api_call "symphony.update_issue_scratchpad" "\${args}" | print_json ;;

  help|--help|-h|"") print_help ;;
  *) echo "Unknown command: \$1"; print_help; exit 64 ;;
esac
EOF

    sed -e "s|INSTALL_DIR=\"\\\${INSTALL_DIR}\"|INSTALL_DIR=\"${INSTALL_DIR}\"|" \
        -e 's|\\\$|$|g' \
        -e 's|\\\\|\\|g' \
        "${BIN_DIR}/${BINARY_NAME}" > "${BIN_DIR}/${BINARY_NAME}.tmp"
    mv "${BIN_DIR}/${BINARY_NAME}.tmp" "${BIN_DIR}/${BINARY_NAME}"
    chmod +x "${BIN_DIR}/${BINARY_NAME}"

    log_info "nano-symphony installed successfully!"
}

# Main
main() {
    log_step "nano-symphony Installer"
    log_step "======================="
    echo ""

    # Check prerequisites
    check_bun

    # Install
    install_symphony

    # Summary
    echo ""
    log_step "Installation complete!"
    echo ""
    log_info "Installation directory: ${INSTALL_DIR}"
    log_info "Binary location:        ${BIN_DIR}/${BINARY_NAME}"
    echo ""
    log_info "Next steps:"
    echo ""
    echo "  1. Review and edit your configuration:"
    echo "     ${INSTALL_DIR}/.env"
    echo ""
    echo "  2. Review and edit your workflow:"
    echo "     ${INSTALL_DIR}/WORKFLOW.md"
    echo ""
    echo "  3. Start the service:"
    if echo ":$PATH:" | grep -q ":${BIN_DIR}:"; then
        echo "     symphony start"
    else
        echo "     ${BIN_DIR}/${BINARY_NAME} start"
        echo ""
        log_warn "${BIN_DIR} is not in your PATH"
        echo "     Add it to your shell profile:"
        echo "     export PATH=\"${BIN_DIR}:\$PATH\""
    fi
    echo ""
    echo "  4. Open the dashboard:"
    echo "     http://localhost:4123"
    echo ""
}

main "$@"

