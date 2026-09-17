@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js LTS, then reopen this file.
  pause
  exit /b 1
)
echo Letters from the Wasteland
echo Open http://127.0.0.1:5176/ in your browser.
echo Keep this window open. Press Ctrl+C to stop.
node server.js 5176
pause
