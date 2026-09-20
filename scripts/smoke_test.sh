#!/usr/bin/env bash
# Headless browser check: load the app, assert no console/network errors,
# hover a zone, and write screenshots. Requires ./run.sh to be serving already.
#
# The browser + its shared libraries + fonts all live under .tools/ (no sudo).
# If they are missing, see the "Headless verification" section of README.md.
#
# The server serves the main checkout, so testing a branch used to mean merging
# it first -- which has put a failing assertion on main more than once. Run this
# from inside a worktree and it tests that worktree, or name one:
#
#   .claude/worktrees/my-branch/scripts/smoke_test.sh
#   ./scripts/smoke_test.sh .claude/worktrees/my-branch
#
# Its web/ files are served to the browser in place of the running server's, and
# its copy of this test is the one that runs -- so a branch that changes both
# the app and its assertions is checked as one thing. Everything else (data,
# artwork, vendor) still comes from the server, none of it being what a branch
# like that touches.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The browser, its libraries and its fonts live under .tools/, which is
# gitignored and so exists only in the main checkout. A worktree borrows them.
TOOLS="$ROOT"
if [ ! -d "$TOOLS/.tools" ]; then
  TOOLS="$(dirname "$(cd "$ROOT" && command git rev-parse --git-common-dir)")"
fi

export PATH="$TOOLS/.tools/bin:$PATH"
export PUPPETEER_CACHE_DIR="$TOOLS/.tools/puppeteer"
export LD_LIBRARY_PATH="$TOOLS/.tools/sysroot/usr/lib/x86_64-linux-gnu:$TOOLS/.tools/sysroot/lib/x86_64-linux-gnu"
export FONTCONFIG_FILE="$TOOLS/.tools/fonts.conf"
export OUTDIR="${OUTDIR:-$ROOT/build}"

mkdir -p "$OUTDIR"

if [ ! -d "$TOOLS/.tools/pptr/node_modules/puppeteer" ]; then
  echo "puppeteer not installed -- see README 'Headless verification'" >&2
  exit 1
fi

# What to test: the worktree named, or this checkout if it is not the one being
# served. Either way the running server still supplies everything else.
BRANCH="${1:-}"
if [ -z "$BRANCH" ] && [ "$ROOT" != "$TOOLS" ]; then
  BRANCH="$ROOT"
fi

SCRIPT="$ROOT/scripts/smoke_test.mjs"
if [ -n "$BRANCH" ]; then
  BRANCH="$(cd "$BRANCH" && pwd)"
  if [ ! -f "$BRANCH/scripts/smoke_test.mjs" ]; then
    echo "no scripts/smoke_test.mjs under $BRANCH" >&2
    exit 1
  fi
  export SMOKE_OVERRIDE_DIR="$BRANCH"
  export SMOKE_TOOLS_ROOT="$TOOLS"
  SCRIPT="$BRANCH/scripts/smoke_test.mjs"
fi

cd "$TOOLS/.tools/pptr"
exec node "$SCRIPT"
