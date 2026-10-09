#!/usr/bin/env bash
# Runs adopt.sh on a copy of the template: first adoption, a second run, then a rename.
# shellcheck disable=SC2016 # single quotes hold the installers' literal ${FORKWARE_REPO:-...}
set -euo pipefail

copy=$(mktemp -d)
cp -r "$(dirname "$0")/../.." "$copy/repo"
cd "$copy/repo"
fail() { echo "FAIL: $*" >&2; exit 1; }
template=$(sed -n 's/^REPO="\${FORKWARE_REPO:-\([^}]*\)}"$/\1/p' installer/install-linux.sh)

echo "1. A new app takes the template's place everywhere"
GITHUB_OUTPUT=out1 .github/adopt.sh you/my-app
grep -qx "changed=true" out1                                    || fail "first run changed nothing"
grep -qx "first=true" out1                                      || fail "first run was not reported as the first"
! grep -rqE "(^|[^A-Za-z0-9_])$template([^A-Za-z0-9_.-]|$)" installer || fail "$template is still named in: $(grep -rlE "(^|[^A-Za-z0-9_])$template([^A-Za-z0-9_.-]|$)" installer)"
grep -qF 'REPO="${FORKWARE_REPO:-you/my-app}"' installer/install-linux.sh  || fail "Linux installer"
grep -qF 'REPO="${FORKWARE_REPO:-you/my-app}"' installer/install-macos.sh  || fail "macOS installer"
grep -qF "else { 'you/my-app' }" installer/install-windows.ps1  || fail "Windows installer"
grep -qx "# my-app" README.md                                    || fail "README was not replaced"
grep -qF "raw.githubusercontent.com/you/my-app/main/installer/install-linux.sh" README.md || fail "README install link"
[ ! -e .github/assets ]                                          || fail "template pictures are still there"
[ -f forkware/manifesto.md ]                                       || fail "the manifesto is gone"
grep -qF "](../forkware/manifesto.md)" installer/README.md        || fail "the manifesto link in installer/README.md was rewritten"

echo "2. A second run changes nothing"
GITHUB_OUTPUT=out2 .github/adopt.sh you/my-app
grep -qx "changed=false" out2                                    || fail "second run changed something"

echo "3. A rename moves the links and keeps the README"
GITHUB_OUTPUT=out3 .github/adopt.sh you/better-app
grep -qx "changed=true" out3                                    || fail "rename changed nothing"
grep -qx "first=false" out3                                     || fail "rename was reported as the first adoption"
! grep -rqF "you/my-app" installer README.md                     || fail "old name is still named"
grep -qx "# my-app" README.md                                    || fail "README was rewritten on rename"

echo "OK"
