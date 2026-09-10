@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js পাওয়া যায়নি। আগে Node.js install করুন।
  pause
  exit /b 1
)
if not exist node_modules\express (
  echo First run: installing server dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install ব্যর্থ হয়েছে। Internet connection/check করুন।
    pause
    exit /b 1
  )
)
echo Starting BDRIS AutoFill server on http://localhost:3000 ...
start "BDRIS Browser" http://localhost:3000
call npm start
pause
