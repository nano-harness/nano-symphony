#!/usr/bin/env bash
set -euo pipefail
if [ ! -f .env ]; then cp .env.example .env; fi
if [ ! -f WORKFLOW.md ]; then cp templates/WORKFLOW.example.md WORKFLOW.md; fi
bun install
cd frontend && bun install
echo "Done!"
