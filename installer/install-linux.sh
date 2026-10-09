#!/usr/bin/env bash
# Forkware installer for Linux.
# Usage: curl -fsSL https://raw.githubusercontent.com/forkware/pitwall/main/installer/install-linux.sh | bash
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

install_git() {
  say "Installing git"
  if   need apt-get; then sudo apt-get update -qq && sudo apt-get install -y git
  elif need dnf;     then sudo dnf install -y git
  elif need pacman;  then sudo pacman -S --noconfirm git
  elif need zypper;  then sudo zypper install -y git
  elif need apk;     then sudo apk add git
  else die "git not found and no known package manager. Install git and re-run."
  fi
}

install_gh() {
  local arch ver tmp pkg
  case "$(uname -m)" in
    x86_64)          arch=amd64 ;;
    aarch64|arm64)   arch=arm64 ;;
    armv6l|armv7l)   arch=armv6 ;;
    i386|i686)       arch=386 ;;
    *) die "unsupported CPU: $(uname -m)" ;;
  esac

  # The latest-release page redirects to its tag; unlike api.github.com it has no anonymous rate limit
  ver=$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/cli/cli/releases/latest \
        | sed -n 's#.*/tag/v##p')
  [ -n "$ver" ] || die "could not determine the latest GitHub CLI version"

  say "Installing GitHub CLI $ver into $BIN"
  pkg="gh_${ver}_linux_${arch}.tar.gz"
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/$pkg"        "https://github.com/cli/cli/releases/download/v${ver}/${pkg}"
  curl -fsSL -o "$tmp/checksums"   "https://github.com/cli/cli/releases/download/v${ver}/gh_${ver}_checksums.txt"
  (cd "$tmp" && grep " ${pkg}\$" checksums | sha256sum -c --quiet) || die "GitHub CLI checksum mismatch"
  tar -xzf "$tmp/$pkg" -C "$tmp"
  mkdir -p "$BIN"
  mv "$tmp/gh_${ver}_linux_${arch}/bin/gh" "$BIN/gh"
  rm -rf "$tmp"

  case ":$PATH:" in
    *":$BIN:"*) ;;
    *) say "Add $BIN to your PATH to use gh in new terminals" ;;
  esac
  export PATH="$BIN:$PATH"
}

main() {
  need curl || die "curl is required"
  need git  || install_git
  need gh   || install_gh

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
