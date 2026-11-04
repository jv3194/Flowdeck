@echo off
rem Starts Flowdeck. Order of preference:
rem   1. Electron installed in this folder (npm install)
rem   2. the Electron next door in ..\electron-app (already on this machine)
rem   3. your default browser, served by the bundled Node server
setlocal
cd /d "%~dp0"

if exist "node_modules\electron\dist\electron.exe" (
  start "" "node_modules\electron\dist\electron.exe" "%~dp0."
  exit /b 0
)
if exist "..\electron-app\node_modules\electron\dist\electron.exe" (
  start "" "..\electron-app\node_modules\electron\dist\electron.exe" "%~dp0."
  exit /b 0
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required: https://nodejs.org
  pause
  exit /b 1
)
echo Electron not found, opening in your browser instead. Run "npm install" for the desktop window.
node server\index.js --open
