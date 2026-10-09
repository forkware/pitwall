@echo off
rem Starts the app; the installer runs it right after cloning.
rem Arguments go to the app: run.cmd --server --port 8080
setlocal
cd /d "%~dp0"
where node >nul 2>&1 || (
  echo Pitwall needs Node.js 22.18 or newer: https://nodejs.org
  exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)" || (
  echo Pitwall needs Node.js 22.18 or newer: https://nodejs.org
  exit /b 1
)
rem pnpm, at the version package.json pins in "packageManager". Without pnpm installed, Corepack (bundled
rem with Node.js up to 24) or npx fetches that version.
set COREPACK_ENABLE_DOWNLOAD_PROMPT=0
set "PNPM=pnpm"
where pnpm >nul 2>&1 || (
  where corepack >nul 2>&1 && set "PNPM=corepack pnpm" || (
    for /f "delims=" %%v in ('node -p "require('./package.json').packageManager"') do set "PNPM=npx --yes %%v"
  )
)
rem Install dependencies on the first run and whenever pnpm-lock.yaml changes.
node -e "const fs=require('fs');const t=f=>fs.statSync(f).mtimeMs;try{process.exit(t('pnpm-lock.yaml')>t('node_modules/.modules.yaml')?1:0)}catch{process.exit(1)}" || (
  call %PNPM% install || exit /b 1
)
call %PNPM% --silent start %*
