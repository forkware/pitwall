#!/usr/bin/env bash
# Forkware installer for macOS.
# Usage: curl -fsSL https://raw.githubusercontent.com/forkware/pitwall/main/installer/install-macos.sh | bash
#
# Env:
#   FORKWARE_REPO  upstream repository to fork (default: forkware/pitwall)
#   FORKWARE_DIR   where the fork is cloned   (default: ~/forkware)
set -euo pipefail

REPO="${FORKWARE_REPO:-forkware/pitwall}"
DIR="${FORKWARE_DIR:-$HOME/forkware}"
BIN="$HOME/.local/bin"

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1; }

ensure_git() {
  # /usr/bin/git is a stub until Command Line Tools are installed, so run it instead of looking it up
  git --version >/dev/null 2>&1 && return
  say "Installing Xcode Command Line Tools (they include git)"
  xcode-select --install || true
  die "Finish the Command Line Tools installation in the dialog, then run this installer again."
}

install_gh() {
  if need brew; then
    say "Installing GitHub CLI with Homebrew"
    brew install gh
    return
  fi

  local arch ver tmp pkg
  case "$(uname -m)" in
    arm64)  arch=arm64 ;;
    x86_64) arch=amd64 ;;
    *) die "unsupported CPU: $(uname -m)" ;;
  esac

  # The latest-release page redirects to its tag; unlike api.github.com it has no anonymous rate limit
  ver=$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/cli/cli/releases/latest \
        | sed -n 's#.*/tag/v##p')
  [ -n "$ver" ] || die "could not determine the latest GitHub CLI version"

  say "Installing GitHub CLI $ver into $BIN"
  pkg="gh_${ver}_macOS_${arch}.zip"
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/$pkg"      "https://github.com/cli/cli/releases/download/v${ver}/${pkg}"
  curl -fsSL -o "$tmp/checksums" "https://github.com/cli/cli/releases/download/v${ver}/gh_${ver}_checksums.txt"
  (cd "$tmp" && grep " ${pkg}\$" checksums | shasum -a 256 -c --quiet) || die "GitHub CLI checksum mismatch"
  unzip -q "$tmp/$pkg" -d "$tmp"
  mkdir -p "$BIN"
  mv "$tmp/gh_${ver}_macOS_${arch}/bin/gh" "$BIN/gh"
  rm -rf "$tmp"

  case ":$PATH:" in
    *":$BIN:"*) ;;
    *) say "Add $BIN to your PATH (e.g. in ~/.zshrc) to use gh in new terminals" ;;
  esac
  export PATH="$BIN:$PATH"
}

main() {
  ensure_git
  need gh || install_gh

  # stdin is the script itself when piped from curl, so talk to the terminal directly
  if ! gh auth status >/dev/null 2>&1; then
    say "Log in to GitHub"
    gh auth login --hostname github.com --web --git-protocol https </dev/tty
  fi
  gh auth setup-git

  local name="${REPO#*/}"
  mkdir -p "$DIR"
  cd "$DIR"
  if [ -d "$name/.git" ]; then
    say "Your fork is already cloned in $DIR/$name"
  else
    say "Forking $REPO and cloning it into $DIR/$name"
    gh repo fork "$REPO" --clone --default-branch-only

    # GitHub turns issues off in forks, but every change starts with an issue
    local fork
    fork=$(git -C "$name" remote get-url origin | sed 's#.*github\.com[:/]##; s#\.git$##')
    say "Turning on issues in $fork"
    gh repo edit "$fork" --enable-issues \
      || say "Could not turn on issues. Enable them in the fork's Settings > General > Features."
  fi
  cd "$name"

  if [ -x ./run.sh ]; then
    say "Starting"
    exec ./run.sh </dev/tty
  fi
  say "Done. Your fork is in $DIR/$name"
}

# Wrapped in main so a partially downloaded script never runs
main "$@"
