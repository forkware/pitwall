#!/usr/bin/env bash
# Runs a Linux or macOS installer end to end against a fake gh, piped into bash the way users run it.
# Usage: tests/installer-smoke.sh installer/install-linux.sh
set -euo pipefail

installer=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
work=$(mktemp -d)
stub=$(cd "$(dirname "$0")" && pwd)/stub
export PATH="$stub:$PATH"
export FORKWARE_REPO=forkware/app FORKWARE_DIR="$work/forks" GH_STUB_LOG="$work/gh.log"
fork="$FORKWARE_DIR/app"

fail() { echo "FAIL: $*" >&2; echo "--- gh calls:" >&2; cat "$GH_STUB_LOG" >&2 || true; exit 1; }
called() { grep -qxF "$1" "$GH_STUB_LOG"; }

echo "1. First install forks, clones and turns on issues"
bash < "$installer" || fail "installer exited with an error"
[ -d "$fork/.git" ]                                       || fail "the fork was not cloned"
called "repo fork forkware/app --clone --default-branch-only" || fail "the repository was not forked"
called "repo edit tester/app --enable-issues"             || fail "issues were not turned on in the fork"

echo "2. Second install reuses the clone"
: > "$GH_STUB_LOG"
bash < "$installer" || fail "second run exited with an error"
! grep -q "^repo fork" "$GH_STUB_LOG"                     || fail "forked again"

echo "3. Install starts run.sh in a terminal"
# shellcheck disable=SC2016 # expands inside run.sh, not here
printf '#!/bin/sh\necho started > "$FORKWARE_DIR/started"\n' > "$fork/run.sh"
chmod +x "$fork/run.sh"
# run.sh reads from /dev/tty, so give the installer a pseudo-terminal
if [ "$(uname)" = Darwin ]; then
  script -q /dev/null bash -c "bash < '$installer'"
else
  script -qec "bash < '$installer'" /dev/null
fi
[ -f "$FORKWARE_DIR/started" ]                            || fail "run.sh was not started"

echo "OK"
