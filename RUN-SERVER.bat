@echo off
setlocal
cd /d "%~dp0"
title BDRIS AutoFill - LOCAL DIRECT

echo ==========================================
echo   BDRIS AutoFill - LOCAL DIRECT MODE
echo   No account / no login / no access link
 echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js পাওয়া যায়নি। Node.js install করুন।
  pause
  exit /b 1
)

for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do (
  echo Port 3000 ব্যবহারকারী পুরোনো server বন্ধ করা হচ্ছে: PID %%P
  taskkill /PID %%P /F >nul 2>nul
)

if not exist node_modules (
  echo প্রথমবার setup হচ্ছে...
  call npm install
  if errorlevel 1 (
    echo npm install ব্যর্থ হয়েছে।
    pause
    exit /b 1
  )
)

echo.
echo Server চালু হচ্ছে...
echo Browser খুলুন: http://localhost:3000
start "" http://localhost:3000
node server.js
pause
