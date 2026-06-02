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
        archive_url="${OSS_BASE_URL}/releases/${tag_version}/nano-symphony-${tag_version}.tar.gz"
    fi

    # Check current version if already installed
    if [ -f "${INSTALL_DIR}/package.json" ]; then
        current_version=$(cd "${INSTALL_DIR}" && bun -e "console.log(require('./package.json').version)" 2>/dev/null || true)
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

    # Create install directory
    mkdir -p "${INSTALL_DIR}"

    # Extract archive; exclude user-config files so they survive updates.
    # Fresh-install initialization happens in the guards below.
    log_info "Extracting archive to ${INSTALL_DIR}..."
    tar -xzf "${tmp_dir}/nano-symphony.tar.gz" -C "${INSTALL_DIR}" --exclude='WORKFLOW.md' --exclude='.env' --exclude='*.db' --exclude='workspaces'

    # Install dependencies
    log_info "Installing dependencies with bun..."
    (
        cd "${INSTALL_DIR}"
        bun install
    )

    # Initialize configuration files if they don't exist
    if [ ! -f "${INSTALL_DIR}/.env" ]; then
        log_info "Creating default .env configuration..."
        cp "${INSTALL_DIR}/.env.example" "${INSTALL_DIR}/.env"
        # W1: Generate a stable random API_TOKEN so the CLI wrapper can authenticate
        # and the server uses the same token across restarts instead of a new random
        # UUID each time.
        api_token="$(bun -e "console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex'))")"
        tmp_env="${INSTALL_DIR}/.env.tmp"
        while IFS= read -r line || [ -n "$line" ]; do
          case "$line" in
            "API_TOKEN=") printf 'API_TOKEN=%s\n' "${api_token}" ;;
            *) printf '%s\n' "$line" ;;
          esac
        done < "${INSTALL_DIR}/.env" > "$tmp_env" && mv "$tmp_env" "${INSTALL_DIR}/.env"
        log_info "Generated API_TOKEN — run 'symphony token' to view it."
    else
        log_warn ".env already exists, skipping initialization"
    fi

    if [ ! -f "${INSTALL_DIR}/WORKFLOW.md" ]; then
        log_info "Creating default WORKFLOW.md..."
        cp "${INSTALL_DIR}/templates/WORKFLOW.example.md" "${INSTALL_DIR}/WORKFLOW.md"
    else
        log_warn "WORKFLOW.md already exists, skipping initialization"
    fi

    # Create wrapper script
    log_info "Creating ${BINARY_NAME} wrapper in ${BIN_DIR}..."
    mkdir -p "${BIN_DIR}"

    cat > "${BIN_DIR}/${BINARY_NAME}" << EOF
#!/usr/bin/env bash
# nano-symphony launcher
# Generated by install.sh

INSTALL_DIR="${INSTALL_DIR}"
PORT="\${SYMPHONY_PORT:-\${PORT:-4123}}"
API_BASE="http://localhost:\${PORT}/api/v1"

# W2: Load API_TOKEN from .env so all curl calls are authenticated.
# The server always enforces auth; without a token every request returns 401.
if [ -f "\${INSTALL_DIR}/.env" ]; then
  _api_token_entry="\$(grep -E '^API_TOKEN=' "\${INSTALL_DIR}/.env")"
  if [ -n "\${_api_token_entry}" ]; then
    # shellcheck disable=SC2046
    export \$(printf '%s' "\${_api_token_entry}" | xargs) 2>/dev/null || true
  fi
  unset _api_token_entry
fi
# Allow caller to override via environment
SYMPHONY_TOKEN="\${API_TOKEN:-\${SYMPHONY_TOKEN:-}}"

# Helper: curl with optional auth header injected
curl_api() {
  if [ -n "\${SYMPHONY_TOKEN}" ]; then
    curl -H "X-Symphony-Token: \${SYMPHONY_TOKEN}" "\$@"
  else
    curl "\$@"
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
  dev                Start backend with file-watch (bun --watch).
  build              Build the frontend (cd frontend && bun run build).
  test               Run bun test. Exit 0 if all pass, 1 otherwise.
  lint               Run tsc --noEmit. Exit 0 if clean.
  status             Probe http://localhost:\${PORT}/api/v1/health. Exit 0 if up, 1 if down.
  token              Print the current API token (from .env or environment).
  update [version]   Read OSS metadata and update nano-symphony (default: latest).
  version            Print version (from \${INSTALL_DIR}/package.json).
  issue list [state] List issues (HTTP GET /api/v1/issues).
  issue get <id>     Get issue (HTTP GET /api/v1/issues/:id).
  issue create <title> [--priority=...] [--state=...]
                     Create issue via HTTP POST /api/v1/issues. Default state: todo.
  help, --help, -h   Print this message.

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
  Logs        : \${INSTALL_DIR}/workspaces/<identifier>/logs/attempt-<n>.log

ENDPOINTS  (defaults; override via PORT or SYMPHONY_PORT)
  HTTP API   : http://localhost:\${PORT}/api/v1
  MCP server : http://localhost:\${PORT}/mcp
  Dashboard  : http://localhost:\${PORT}

KEY REST PATHS
  GET    /api/v1/issues[?state=...]
  GET    /api/v1/issues/:id
  POST   /api/v1/issues       {identifier,title,state,...}
  PUT    /api/v1/issues/:id
  GET    /api/v1/runs
  GET    /api/v1/events[?since=ts]
  GET    /api/v1/events/stream  (SSE)
  POST   /api/v1/runs/:id/{cancel|pause|resume}
  GET    /api/v1/workflow
  PUT    /api/v1/workflow

MCP TOOLS  (callable via JSON-RPC at /mcp with X-Symphony-Token header)
  symphony.fetch_issue
  symphony.report_event
  symphony.update_token_stats
  symphony.request_workflow_section
  symphony.suggest_state_transition
  symphony.session_completed
  symphony.create_issue            (NEW)
  symphony.activate_issue          (NEW)

ENVIRONMENT VARIABLES
  PORT                  4123       HTTP port
  SYMPHONY_PORT         4123       Wrapper HTTP port override
  API_TOKEN             (required) Control-plane auth token. Read from \${INSTALL_DIR}/.env or
                                   env. Use 'symphony token' to show the current value.
  SYMPHONY_TOKEN                   Alias for API_TOKEN accepted by the wrapper.
  DB_PATH               ./symphony.db
  WORKFLOW_PATH         ./WORKFLOW.md
  NANO_BIN              nano       Default agent binary
  WORKSPACE_ROOT        ./workspaces
  LOG_LEVEL             info       trace|debug|info|warn|error|fatal
  MAX_CONCURRENT_AGENTS 3
  MCP_TOKEN_TTL_MS      3600000
  ORCHESTRATOR_TICK_MS  5000

EXIT CODES
  0  success
  1  command failed (test/lint/status fail, HTTP error)
  2  install dir missing or unusable
  64 unknown subcommand or invalid usage
HLP
}

next_identifier() {
  curl_api -fsS "\${API_BASE}/issues" | bun -e '
const chunks = [];
for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
const issues = JSON.parse(Buffer.concat(chunks).toString() || "[]");
let max = 0;
for (const issue of issues) {
  const match = String(issue.identifier ?? "").match(/^TASK-(\\d+)$/);
  if (match) max = Math.max(max, Number(match[1]));
}
console.log("TASK-" + (max + 1));
'
}

json_string() {
  VALUE="\$1" bun -e 'console.log(JSON.stringify(process.env.VALUE ?? ""))'
}

issue_usage() {
  echo "Usage: symphony issue {list [state]|get <id>|create <title> [--priority=...] [--state=...]}"
}

case "\${1:-}" in
  start)   exec bun run start ;;
  dev)     exec bun run dev ;;
  build)   exec bun run build ;;
  test)    exec bun test ;;
  lint)    exec bun run lint ;;
  status)
    # W2: Probe /health (auth-exempt) instead of /runs so status works without a token
    # and also provides a reliable liveness signal even before any issues exist.
    if curl -fsS "\${API_BASE}/health" >/dev/null 2>&1; then
      echo "symphony: running on :\${PORT}"; exit 0
    else
      echo "symphony: NOT running on :\${PORT}"; exit 1
    fi ;;
  token)
    # W2: Print the token the wrapper is currently using so operators can copy it.
    if [ -n "\${SYMPHONY_TOKEN}" ]; then
      echo "\${SYMPHONY_TOKEN}"
    else
      echo "No API_TOKEN found. Set API_TOKEN in \${INSTALL_DIR}/.env or via environment."
      exit 1
    fi ;;
  update)
    requested_version="\${2:-}"
    current_version="\$(bun -e "console.log(require('\${INSTALL_DIR}/package.json').version)" 2>/dev/null || true)"
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
    bun -e "console.log(require('\${INSTALL_DIR}/package.json').version)" ;;
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
        # W8: Default to 'todo' (not 'backlog') so issues are picked up by the
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
        identifier="\$(next_identifier)" || exit 1
        [ "\${identifier}" ] || { echo "Failed to generate issue identifier"; exit 1; }
        title_json="\$(json_string "\${title}")"
        priority_json="\$(json_string "\${priority}")"
        state_json="\$(json_string "\${state}")"
        identifier_json="\$(json_string "\${identifier}")"
        curl_api -fsS -X POST "\${API_BASE}/issues" \
          -H 'Content-Type: application/json' \
          -d "{\"identifier\":\${identifier_json},\"title\":\${title_json},\"priority\":\${priority_json},\"state\":\${state_json},\"labels\":[]}" ;;
      *) issue_usage; exit 64 ;;
    esac ;;
  help|--help|-h|"") print_help ;;
  *) echo "Unknown command: \$1"; print_help; exit 64 ;;
esac
EOF

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
