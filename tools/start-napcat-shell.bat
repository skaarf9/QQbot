@echo off
chcp 65001 >nul
setlocal EnableExtensions DisableDelayedExpansion

REM ============================================================================
REM  NapCat.Shell launcher (logged + self-elevating), the variant this project
REM  has been running all along.
REM
REM  Usage:  tools\start-napcat-shell.bat
REM          tools\start-napcat-shell.bat -q 2178517838   (quick login / account)
REM  Log:    NapCat.Shell\logs\*.log  (NAPCAT_DISABLE_MULTI_PROCESS=1 is required
REM          for file logging to work at all; see docs/04 pitfall list.)
REM
REM  ASCII-only on purpose: cmd.exe decodes .bat as the OEM codepage.
REM ============================================================================

set "SCRIPT_DIR=%~dp0"
set "ROOT=%SCRIPT_DIR%.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
set "SH=%ROOT%\NapCat.Shell"
set "SELF=%ROOT%\tools\start-napcat-shell.bat"

if not exist "%SH%\NapCatWinBootMain.exe" ( echo [x] missing NapCat.Shell & pause & exit /b 1 )
if not exist "%SH%\NapCatWinBootHook.dll" ( echo [x] missing NapCat.Shell & pause & exit /b 1 )
if not exist "%SH%\napcat.mjs"            ( echo [x] missing NapCat.Shell & pause & exit /b 1 )

net session >nul 2>&1
if not %ERRORLEVEL% == 0 (
    echo Not elevated - requesting UAC...
    powershell -NoProfile -Command "Start-Process -FilePath 'cmd.exe' -WorkingDirectory '%SH%' -ArgumentList '/c','\"%SELF%\" %*' -Verb RunAs"
    exit /b
)

REM file logging only works with multiprocess off
set NAPCAT_DISABLE_MULTI_PROCESS=1

pushd "%SH%"
call "%SH%\launcher-win10-user.bat" %*
popd

echo [i] NapCat.Shell launch returned; check %SH%\logs
