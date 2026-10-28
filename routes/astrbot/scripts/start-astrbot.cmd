@echo off
chcp 65001 >nul
setlocal
set "ROOT=%~dp0.."
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
pushd "%ROOT%\app"
echo [i] AstrBot: http://127.0.0.1:6186
..\bin\astrbot.exe run --port 6186
popd
endlocal
