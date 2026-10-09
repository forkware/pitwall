#!/usr/bin/env bash
# Starts the app; the installer runs it right after cloning.
# Arguments go to the app: ./run.sh --server --port 8080
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1 || ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)'; then
  echo "Pitwall needs Node.js 22.18 or newer: https://nodejs.org"
  exit 1
fi

# pnpm, at the version package.json pins in "packageManager". Without pnpm installed, Corepack (bundled
# with Node.js up to 24) or npx fetches that version.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
if command -v pnpm >/dev/null 2>&1; then
  pnpm=(pnpm)
elif command -v corepack >/dev/null 2>&1; then
  pnpm=(corepack pnpm)
else
  pnpm=(npx --yes "$(node -p 'require("./package.json").packageManager')")
fi

# Install dependencies on the first run and whenever pnpm-lock.yaml changes.
stamp=node_modules/.modules.yaml
if [ ! -f "$stamp" ] || [ pnpm-lock.yaml -nt "$stamp" ]; then
  "${pnpm[@]}" install
fi

exec "${pnpm[@]}" --silent start "$@"
