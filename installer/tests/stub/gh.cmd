@echo off
rem Fake GitHub CLI for Windows installer tests, see gh-stub.ps1
pwsh -NoProfile -File "%~dp0gh-stub.ps1" %*
exit /b %ERRORLEVEL%
