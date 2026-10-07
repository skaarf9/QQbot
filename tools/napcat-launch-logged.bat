@echo off
REM NapCat force-disables file logging in multi-process mode (napcat.mjs L82216:
REM NAPCAT_WORKER_PROCESS!=1 && NAPCAT_DISABLE_MULTI_PROCESS!=1 -> setFileLogEnabled(false)),
REM so config\napcat.json "fileLog": true only produces real files with multiprocess off.
REM
REM Usage: tools\napcat-launch-logged.bat -q 2178517838
REM Logs land under NapCat.Shell\logs\.
set NAPCAT_DISABLE_MULTI_PROCESS=1
cd /d D:\deepseek\QQbot\NapCat.Shell
call launcher-win10-user.bat %*
