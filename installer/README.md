# Installer

Rule 1 of the [manifesto](../forkware/manifesto.md): installing means forking. One command, and the user has their own copy of the app's code.

```sh
# Linux
curl -fsSL https://raw.githubusercontent.com/forkware/pitwall/main/installer/install-linux.sh | bash
# macOS
curl -fsSL https://raw.githubusercontent.com/forkware/pitwall/main/installer/install-macos.sh | bash
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/forkware/pitwall/main/installer/install-windows.ps1 | iex
```

## What it does

1. Installs git and the GitHub CLI if they are missing: the system package manager on Linux, Command Line Tools and Homebrew or the official release on macOS, winget on Windows. Downloaded GitHub CLI releases are checked against their published checksums.
2. Logs in to GitHub in the browser, unless already logged in.
3. Forks the app's repository and clones the fork. Running it again reuses the clone.
4. Turns on issues in the fork. GitHub turns them off in forks, but every change starts with an issue (rule 2).
5. Starts `run.sh` (`run.cmd` on Windows) from the fork, if the app has one.

| Variable | Default | |
|---|---|---|
| `FORKWARE_REPO` | `forkware/pitwall` | Repository to fork |
| `FORKWARE_DIR` | `~/forkware` | Where the fork is cloned |

```sh
curl -fsSL https://raw.githubusercontent.com/forkware/pitwall/main/installer/install-linux.sh | FORKWARE_REPO=owner/app bash
```

## Tests

CI runs each installer on its own system, Linux, macOS, and Windows under PowerShell 7 and 5.1, against a fake `gh` in [`tests/stub/`](tests/stub/). The tests check that the installer forks, turns on issues, reuses the clone on a second run and starts the app. Linux and macOS also download a real GitHub CLI release and verify it.

```sh
installer/tests/installer-smoke.sh installer/install-linux.sh
installer/tests/install-gh.sh installer/install-linux.sh
```
