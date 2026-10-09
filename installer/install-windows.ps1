# Forkware installer for Windows 10/11.
# Usage (PowerShell): irm https://raw.githubusercontent.com/forkware/pitwall/main/installer/install-windows.ps1 | iex
#
# Env:
#   FORKWARE_REPO  upstream repository to fork (default: forkware/pitwall)
#   FORKWARE_DIR   where the fork is cloned   (default: ~\forkware)

# Runs in its own scope so settings do not leak into the user's session under iex
& {
  $ErrorActionPreference = 'Stop'

  $Repo = if ($env:FORKWARE_REPO) { $env:FORKWARE_REPO } else { 'forkware/pitwall' }
  $Dir  = if ($env:FORKWARE_DIR)  { $env:FORKWARE_DIR }  else { Join-Path $HOME 'forkware' }

  function Say($msg)  { Write-Host "==> $msg" -ForegroundColor Green }
  function Need($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

  # winget does not update PATH in the current session
  function Update-SessionPath {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path', 'User')
  }

  function Install-WithWinget($id, $label) {
    if (-not (Need winget)) {
      throw "$label not found, and neither is winget. Install `"App Installer`" from Microsoft Store and run this installer again."
    }
    Say "Installing $label"
    winget install --id $id -e --source winget --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw "Could not install $label with winget" }
    Update-SessionPath
  }

  # Windows PowerShell 5.1 turns native stderr into errors under 'Stop', so relax it for this probe
  function Test-GhLogin {
    $ErrorActionPreference = 'Continue'
    gh auth status 2>&1 | Out-Null
    return ($LASTEXITCODE -eq 0)
  }

  if (-not (Need git)) { Install-WithWinget 'Git.Git' 'Git' }
  if (-not (Need gh))  { Install-WithWinget 'GitHub.cli' 'GitHub CLI' }

  if (-not (Test-GhLogin)) {
    Say 'Log in to GitHub'
    gh auth login --hostname github.com --web --git-protocol https
    if ($LASTEXITCODE -ne 0) { throw 'GitHub login failed' }
  }
  gh auth setup-git

  $Name = $Repo.Split('/')[-1]
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  Set-Location $Dir

  if (Test-Path (Join-Path $Name '.git')) {
    Say "Your fork is already cloned in $Dir\$Name"
  } else {
    Say "Forking $Repo and cloning it into $Dir\$Name"
    gh repo fork $Repo --clone --default-branch-only
    if ($LASTEXITCODE -ne 0) { throw "Could not fork $Repo" }

    # GitHub turns issues off in forks, but every change starts with an issue
    $Fork = (git -C $Name remote get-url origin) -replace '^.*github\.com[:/]', '' -replace '\.git$', ''
    Say "Turning on issues in $Fork"
    gh repo edit $Fork --enable-issues
    if ($LASTEXITCODE -ne 0) {
      Write-Host "Could not turn on issues. Enable them in the fork's Settings > General > Features." -ForegroundColor Yellow
    }
  }
  Set-Location $Name

  # run.cmd, not run.ps1: execution policy often blocks local .ps1 files
  if (Test-Path '.\run.cmd') {
    Say 'Starting'
    & .\run.cmd
  } else {
    Say "Done. Your fork is in $Dir\$Name"
  }
}
