@echo off
cd /d "%~dp0"
if not exist "node_modules\pg" call :install
if errorlevel 1 exit /b 1
if not exist "node_modules\php-parser" call :install
if errorlevel 1 exit /b 1
node server.js --open
exit /b
:install
echo Installing ER Atlas dependencies...
call npm install --omit=dev
if errorlevel 1 (
  pause
  exit /b 1
)
exit /b 0
