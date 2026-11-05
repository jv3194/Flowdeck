@echo off
rem Double-click to install Flowdeck for your user account (no administrator needed).
rem Windows blocks unsigned scripts by default; "-ExecutionPolicy Bypass" lets this one script run, and only this one.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Flowdeck.ps1" -DesktopShortcut %*
if errorlevel 1 (
  echo.
  echo Installing did not finish. The message above says why.
  pause
)
