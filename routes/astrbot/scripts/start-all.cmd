@echo off
chcp 65001 >nul
echo [i] starting DSH qqbot (ingress :3188) ...
start "DSH qqbot" cmd /k "%~dp0start-dsh-qqbot.cmd"
timeout /t 3 >nul
echo [i] starting AstrBot (WebUI :6186) ...
start "AstrBot" cmd /k "%~dp0start-astrbot.cmd"
timeout /t 5 >nul
start "" http://127.0.0.1:6186
