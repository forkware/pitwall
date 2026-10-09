#!/usr/bin/env bash
# Makes a repository created from the Forkware template its own: the installers fork it
# and their links point at it. After a rename it moves them to the new name.
# Does nothing when everything already points at the repository.
#
# Usage: .github/adopt.sh owner/repo
# Writes changed=true|false and first=true|false to $GITHUB_OUTPUT.
set -euo pipefail

new=$1
cd "$(dirname "$0")/.."
out=${GITHUB_OUTPUT:-/dev/null}

# shellcheck disable=SC2016 # matches the literal ${FORKWARE_REPO:-...} in the installer
old=$(sed -n 's/^REPO="\${FORKWARE_REPO:-\([^}]*\)}"$/\1/p' installer/install-linux.sh)
[ -n "$old" ] || { echo "Could not find the default FORKWARE_REPO in installer/install-linux.sh" >&2; exit 1; }

if [ "$old" = "$new" ]; then
  echo "Installers already point at $new"
  printf 'changed=false\nfirst=false\n' >> "$out"
  exit 0
fi

echo "Pointing installers at $new instead of $old"
old_re=$(printf '%s' "$old" | sed 's/[.[\*^$]/\\&/g')
grep -rlF "$old" installer README.md | while read -r f; do
  # Whole names only: forkware/manifesto.md is a file in the repository, not the repository
  sed -E -i "s#(^|[^A-Za-z0-9_])$old_re([^A-Za-z0-9_.-]|\$)#\1$new\2#g" "$f"
done

first=false
if grep -q '<!-- forkware:template -->' README.md; then
  first=true
  name=${new#*/}
  raw="https://raw.githubusercontent.com/$new/main/installer"
  # The template's own page and pictures; the app gets a README of its own
  rm -rf .github/assets
  cat > README.md <<EOF
# $name

One sentence about what $name does.

A [Forkware](https://github.com/forkware/manifesto) app. Installing it gives you your own fork, which you shape to fit yourself with an AI agent. How it works: [the manifesto](forkware/manifesto.md).

## Install

\`\`\`sh
# Linux
curl -fsSL $raw/install-linux.sh | bash
# macOS
curl -fsSL $raw/install-macos.sh | bash
\`\`\`

\`\`\`powershell
# Windows (PowerShell)
irm $raw/install-windows.ps1 | iex
\`\`\`
EOF
fi

printf 'changed=true\nfirst=%s\n' "$first" >> "$out"
