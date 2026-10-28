@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0..\app"
if not exist "..\logs" mkdir "..\logs"
"..\bin\astrbot.exe" run --port 6186 >> "..\logs\astrbot-run.log" 2>&1
endlocal
