@echo off
setlocal
cd /d "%~dp0"

echo.
echo AudioTool installer
echo This window will ask for Administrator permission, then install
echo Node.js, pnpm, FFmpeg, PostgreSQL, and the app dependencies.
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-audiotool.ps1" %*

if errorlevel 1 (
  echo.
  echo AudioTool could not be installed. Read the message above or install-audiotool.log.
  pause
)

endlocal
