@echo off
setlocal

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-audiotool.ps1"

if errorlevel 1 (
  echo.
  echo AudioTool could not be started. Review the message above.
  pause
)

endlocal
