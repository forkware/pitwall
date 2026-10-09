# Runs the Windows installer end to end against a fake gh, through Invoke-Expression the way users run it.
# Usage: tests/installer-smoke.ps1 installer/install-windows.ps1
param([Parameter(Mandatory)][string]$Installer)
$ErrorActionPreference = 'Stop'

$Installer = (Resolve-Path $Installer).Path
$Work = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid())
New-Item -ItemType Directory -Path $Work | Out-Null
$env:Path = (Join-Path $PSScriptRoot 'stub') + ';' + $env:Path
$env:FORKWARE_REPO = 'forkware/app'
$env:FORKWARE_DIR  = Join-Path $Work 'forks'
$env:GH_STUB_LOG   = Join-Path $Work 'gh.log'
$Fork = Join-Path $env:FORKWARE_DIR 'app'

function Fail($msg) {
  Write-Host '--- gh calls:'
  if (Test-Path $env:GH_STUB_LOG) { Get-Content $env:GH_STUB_LOG | Write-Host }
  throw "FAIL: $msg"
}
function Called($line) { (Test-Path $env:GH_STUB_LOG) -and ((Get-Content $env:GH_STUB_LOG) -contains $line) }
function Install { Get-Content $Installer -Raw | Invoke-Expression }

Write-Host '1. First install forks, clones and turns on issues'
Install
if (-not (Test-Path (Join-Path $Fork '.git')))                          { Fail 'the fork was not cloned' }
if (-not (Called 'repo fork forkware/app --clone --default-branch-only')) { Fail 'the repository was not forked' }
if (-not (Called 'repo edit tester/app --enable-issues'))               { Fail 'issues were not turned on in the fork' }

Write-Host '2. Second install reuses the clone'
Remove-Item $env:GH_STUB_LOG
Install
if ((Get-Content $env:GH_STUB_LOG) -match '^repo fork')                 { Fail 'forked again' }

Write-Host '3. Install starts run.cmd'
Set-Content -Path (Join-Path $Fork 'run.cmd') -Value '@echo started> "%FORKWARE_DIR%\started"'
Install
if (-not (Test-Path (Join-Path $env:FORKWARE_DIR 'started')))           { Fail 'run.cmd was not started' }

Write-Host 'OK'
