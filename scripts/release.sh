#!/usr/bin/env bash
# Interactive release for agent-helper-internal: check -> pack -> GitHub Release with the tarball attached.
# Usage: ./scripts/release.sh [check|pack|publish|all]   (default: all)
# Needs `gh` authenticated with write access to the repo (gh auth login, or GH_TOKEN).
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="${AHI_REPO:-llmforagents/agent-helper-internal}"
VERSION="$(node -p "require('./package.json').version")"
TARBALL="llmforagents-agent-helper-internal-${VERSION}.tgz"

phase() { echo "=== $1 ===" >&2; }

check() {
  phase Check
  npm ci --no-audit --no-fund
  npm run typecheck
  npm test
}

pack() {
  phase Pack
  rm -f ./*.tgz
  npm pack --silent >/dev/null
  test -f "$TARBALL" || { echo "expected $TARBALL" >&2; exit 1; }
  echo "$TARBALL"
}

publish() {
  phase Publish
  [ -z "$(git status --porcelain)" ] || { echo "working tree is dirty; commit first" >&2; exit 1; }
  git rev-parse "v${VERSION}" >/dev/null 2>&1 && { echo "tag v${VERSION} already exists; bump the version" >&2; exit 1; }
  read -r -p "Create release v${VERSION} on ${REPO}? [y/N] " ans
  [ "$ans" = "y" ] || { echo "aborted" >&2; exit 1; }
  git tag "v${VERSION}"
  git push origin "v${VERSION}"
  gh release create "v${VERSION}" "$TARBALL" --repo "$REPO" --title "v${VERSION}" \
    --notes "Install: gh release download v${VERSION} --repo ${REPO} --pattern '*.tgz' -D /tmp/ahi && npm i -g /tmp/ahi/${TARBALL}"
}

case "${1:-all}" in
  check) check ;;
  pack) pack ;;
  publish) publish ;;
  all) check; pack; publish ;;
  *) echo "usage: $0 [check|pack|publish|all]" >&2; exit 2 ;;
esac
