#!/usr/bin/env bash
# scripts/build-bundle.sh
# Produces dist/nano-symphony-<VERSION>.tar.gz containing:
#   index.js           – minified Bun bundle (~484 KB)
#   fsevents*.node     – chokidar native binding (macOS only, emitted automatically)
#   share/
#     frontend/dist/   – compiled Vite frontend
#     skills/          – agent skill markdown files
#     templates/       – WORKFLOW.example.md
#     VERSION          – semver string (no "v" prefix)
#
# Usage:
#   VERSION=0.1.5 bash scripts/build-bundle.sh
#   bash scripts/build-bundle.sh   # defaults to VERSION=dev
#
set -euo pipefail

VERSION="${VERSION:-dev}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "[bundle] building nano-symphony ${VERSION}"
echo "[bundle] repo: ${REPO_ROOT}"

cd "${REPO_ROOT}"

# ── 1. Build frontend ────────────────────────────────────────────────────────
echo "[bundle] building frontend..."
(cd frontend && bun install --frozen-lockfile && bun run build)

# ── 2. Prepare staging area ──────────────────────────────────────────────────
rm -rf dist/staging
mkdir -p dist/staging/share/frontend

cp -r frontend/dist dist/staging/share/frontend/dist

# ── 3. Bundle backend ────────────────────────────────────────────────────────
echo "[bundle] bundling backend..."
bun build src/index.ts \
  --outdir=dist/staging \
  --minify \
  --target=bun

# ── 4. Copy share assets ─────────────────────────────────────────────────────
cp -r skills    dist/staging/share/skills
cp -r templates dist/staging/share/templates
echo "${VERSION}" > dist/staging/share/VERSION

# ── 5. Create archive ────────────────────────────────────────────────────────
ARCHIVE="nano-symphony-${VERSION}.tar.gz"
echo "[bundle] creating dist/${ARCHIVE}..."
mkdir -p dist
tar -czf "dist/${ARCHIVE}" -C dist/staging .

(
  cd dist
  if command -v sha256sum > /dev/null 2>&1; then
    sha256sum "${ARCHIVE}" > "${ARCHIVE}.sha256"
  elif command -v shasum > /dev/null 2>&1; then
    shasum -a 256 "${ARCHIVE}" > "${ARCHIVE}.sha256"
  else
    echo "[bundle] WARNING: neither sha256sum nor shasum found, skipping checksum"
  fi
)

echo "[bundle] done → dist/${ARCHIVE}"
