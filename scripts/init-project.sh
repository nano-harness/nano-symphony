#!/usr/bin/env bash
set -euo pipefail
if [ ! -f .env ]; then
  cp .env.example .env
  # W4: Generate a stable random API_TOKEN so every `bun run start` uses the same
  # token; without this the server auto-generates a new UUID on each restart.
  api_token="$(bun -e "console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex'))")"
  tmp_env=".env.tmp"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "API_TOKEN=") printf 'API_TOKEN=%s\n' "${api_token}" ;;
      *) printf '%s\n' "$line" ;;
    esac
  done < .env > "$tmp_env" && mv "$tmp_env" .env
  echo "Generated API_TOKEN — run: grep API_TOKEN .env"
fi
if [ ! -f WORKFLOW.md ]; then cp templates/WORKFLOW.example.md WORKFLOW.md; fi
bun install
cd frontend && bun install
echo "Done!"
