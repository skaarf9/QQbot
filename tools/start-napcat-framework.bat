@echo off
chcp 65001 >nul
setlocal EnableExtensions DisableDelayedExpansion

REM ============================================================================
REM  NapCat.Framework launcher: fixes working dir, self-elevates, logs to file.
REM
REM  Why this exists:
REM   1) NapCat.Framework\napiLoader.bat builds the napiloader.dll / napimain.exe /
REM      nativeLoader.cjs paths from %cd%, but never self-elevates. "Run as
REM      administrator" from Explorer starts it with %cd% = C:\Windows\System32,
REM      so all three paths are wrong and the window vanishes; a plain
REM      double-click fails injection because it is not elevated. This script
REM      cd's into the Framework dir first, then calls it.
REM   2) The Framework build reads the same config dir as Shell
REM      (NapCat.Framework\config is junctioned to NapCat.Shell\config), so the
REM      existing login and OneBot settings are reused - no QR re-scan.
REM
REM  Usage:  tools\start-napcat-framework.bat
REM          tools\start-napcat-framework.bat -q 2178517838   (quick login)
REM  Log:    NapCat.Shell\logs\napcat-framework-console.log
REM ============================================================================

REM --- ASCII-only text below this line: cmd.exe decodes .bat as the OEM codepage,
REM     so any UTF-8 Chinese here would be mojibake, and a mangled line can even
REM     turn into a bogus command. Keep this file English. ---

set "SCRIPT_DIR=%~dp0"
set "ROOT=%SCRIPT_DIR%.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
set "FW=%ROOT%\NapCat.Framework"
set "LOGDIR=%ROOT%\NapCat.Shell\logs"
set "LOG=%LOGDIR%\napcat-framework-console.log"
set "SELF=%ROOT%\tools\start-napcat-framework.bat"

if not exist "%FW%\napimain.exe"     ( echo [x] missing: %FW%\napimain.exe & pause & exit /b 1 )
if not exist "%FW%\napiloader.dll"   ( echo [x] missing: %FW%\napiloader.dll & pause & exit /b 1 )
if not exist "%FW%\nativeLoader.cjs" ( echo [x] missing: %FW%\nativeLoader.cjs & pause & exit /b 1 )

net session >nul 2>&1
if not %ERRORLEVEL% == 0 (
    echo Not elevated - requesting UAC...
    powershell -NoProfile -Command "Start-Process -FilePath 'cmd.exe' -WorkingDirectory '%FW%' -ArgumentList '/c','\"%SELF%\" %*' -Verb RunAs"
    exit /b
)

if not exist "%LOGDIR%" mkdir "%LOGDIR%"
echo ================ %DATE% %TIME% framework launch ================ >> "%LOG%"

REM The working directory must be the Framework dir: napiLoader.bat resolves
REM NAPCAT_INJECT_PATH / NAPCAT_LAUNCHER_PATH / NAPCAT_MAIN_PATH from %cd%.
pushd "%FW%"
call "%FW%\napiLoader.bat" %* >> "%LOG%" 2>&1
popd

echo [i] injection fired; log: %LOG%
