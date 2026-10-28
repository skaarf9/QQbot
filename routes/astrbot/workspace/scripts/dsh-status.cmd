@echo off
rem dsh-status one-command entry (Windows)
rem Usage: dsh-status.cmd [--json] [--cwd D:\path] [--profile qqbot] [--days 14]
setlocal
set "NODE_NO_WARNINGS=1"
node "%~dp0dsh-status.cjs" %*
exit /b %errorlevel%
