@echo off
chcp 65001 >nul
setlocal
set "D=%~1"
if "%D%"=="" set "D=15"
timeout /t %D% /nobreak >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0kill-astrbot.ps1"
call "%~dp0run-astrbot.cmd"
endlocal
