@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [Loi] Chua cai Node.js. Tai: https://nodejs.org
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Lan dau — dang npm install...
  call npm install
  if errorlevel 1 (
    echo [Loi] npm install that bai.
    pause
    exit /b 1
  )
)

echo F User Guide Tool — Starting...
echo Keep this window OPEN.
echo.
node server.js
pause
