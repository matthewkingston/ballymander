#!/usr/bin/env bash
# Build, then publish the site to ballymander.dev.
#   ./scripts/deploy.sh             build if needed, then upload
#   ./scripts/deploy.sh --dry-run   show what would change, upload nothing
#
# What goes up is the committed web/ (so stray files and unfinished edits stay
# local) plus the generated web/data/ and web/vendor/, which git ignores. The
# server's copy is made to match exactly: files gone from here go there too.
#
# Caddy on the server serves ~/server/sites/ballymander/ as-is, so an upload is
# live immediately; nothing needs restarting. The server's own config lives in
# the separate ~/server repo.
set -euo pipefail

HOST="${BALLYMANDER_HOST:-matt@2.29.25.238}"
DEST="server/sites/ballymander/"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RSYNC_ARGS=()
case "${1:-}" in
  --dry-run) RSYNC_ARGS+=(--dry-run) ;;
  "") ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

./run.sh --build-only

if ! git diff --quiet HEAD -- web \
   || [ -n "$(git ls-files --others --exclude-standard web)" ]; then
  echo "note: web/ has uncommitted changes; they are not deployed" >&2
fi

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
git archive HEAD web | tar -x -C "$stage"
cp -a web/data web/vendor "$stage/web/"

rsync -avz --delete --mkpath "${RSYNC_ARGS[@]}" "$stage/web/" "$HOST:$DEST"
