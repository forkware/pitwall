#!/usr/bin/env bash
# Downloads GitHub CLI with an installer's own install_gh and checks that it runs.
# Uses a clean HOME and a bare PATH, so the preinstalled gh and Homebrew stay out of the way.
# Usage: tests/install-gh.sh installer/install-linux.sh
set -euo pipefail

home=$(mktemp -d)
# Everything except the final `main "$@"`, so sourcing only defines the functions
functions=$(sed '/^main "\$@"$/d' "$1")

HOME="$home" PATH=/usr/bin:/bin:/usr/sbin:/sbin bash -c "$functions
install_gh
\"\$BIN/gh\" --version"
