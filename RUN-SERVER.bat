@echo off
setlocal
cd /d "%~dp0"
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3000 ^| findstr LISTENING') do taskkill /PID %%a /F >nul 2>&1
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
echo.
echo ==========================================
echo   BDRIS AutoFill - User Login Mode
echo ==========================================
echo   Local: http://localhost:3000
 echo.
start "" http://localhost:3000
node server.js
pause
