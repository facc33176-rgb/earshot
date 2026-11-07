@echo off
rem Windows: double-click to start Earshot. Windows 双击启动。
cd /d "%~dp0"
where node >nul 2>nul || (echo Please install Node.js first: https://nodejs.org & pause & exit /b 1)
if not exist .env node tools\setup.cjs
start "" http://localhost:8787
node server\index.js
pause
