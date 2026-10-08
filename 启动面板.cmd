@echo off
chcp 65001 >nul
REM ============================================================================
REM  QQbot one-click panel launcher (Koishi + NapCat) -- self-elevating.
REM
REM  Double-click this file. It asks for UAC ONCE and then runs the panel as
REM  administrator, which is what makes the panel able to start NapCat WITHOUT
REM  any further UAC prompt (NapCat must inject into QQ.exe, so it needs admin).
REM
REM  A non-elevated panel has to ask for UAC through a hidden powershell child,
REM  and on this machine that request never shows a prompt (2026-10-08: the
REM  panel just waited and timed out). Hence: elevate the panel up front.
REM
REM  Usage:
REM    double-click                     -> UAC once, then a UAC-free panel
REM    this-file.cmd --no-elevate       -> start the panel unelevated (debug).
REM                                        Starting NapCat will then need UAC;
REM                                        use the console-launch button instead.
REM
REM  If the panel is already running, this only opens one more browser tab - it
REM  never starts a second panel (server.cjs checks port 5151 and exits 0).
REM
REM  Closing this console window stops the PANEL ONLY; Koishi and NapCat keep
REM  running (stop those with the buttons on the panel page).
REM
REM  ASCII-only + CRLF on purpose: cmd.exe parses .bat in the OEM codepage, so
REM  non-ASCII text and LF-only line endings both break it (learned the hard way).
REM ============================================================================

setlocal EnableExtensions
REM ROOT keeps its trailing backslash on purpose: every use below is "%ROOT%xxx".
REM (Do NOT "normalize" it by assigning %%~fI of "%ROOT%." -- that removes the
REM  backslash and silently turns the path below into "QQbottools\...". 2026-10-08:
REM  exactly that shipped, and this launcher died with "[x] server.cjs not found".)
set "ROOT=%~dp0"
cd /d "%ROOT%"

where node >nul 2>nul
if errorlevel 1 (
  echo [x] node.exe not found - install Node.js 22+ and make sure it is in PATH.
  pause
  exit /b 1
)

if not exist "%ROOT%tools\panel\server.cjs" (
  echo [x] tools\panel\server.cjs not found - did you move this file out of the repo?
  pause
  exit /b 1
)

REM --no-elevate: run it as-is (debugging the panel itself)
if /i "%~1"=="--no-elevate" goto run

REM A space in the folder path cannot survive the powershell line below: the path is
REM expanded INTO the -Command string, so powershell splits it. Measured 2026-10-08:
REM every quoting variant (bare / \" / "..." / [char]34) launched a space-free path
REM fine and failed for a path with a space. Explorer's "Run as administrator" does
REM not go through that string, so it is the workaround.
if not "%ROOT%"=="%ROOT: =%" (
  echo [x] this folder path contains a space: %ROOT%
  echo     self-elevation cannot quote it safely - right-click this file and pick
  echo     "Run as administrator" instead ^(or move the project to a path without spaces^).
  pause
  exit /b 1
)

REM LanmanServer may be stopped, in which case "net session" fails even when we
REM ARE elevated -- whoami /groups is the fallback (High = S-1-16-12288).
net session >nul 2>&1
if not errorlevel 1 goto run
whoami /groups 2>nul | findstr /c:"S-1-16-12288" >nul 2>&1
if not errorlevel 1 goto run

echo Not elevated - requesting UAC ^(one prompt, then NapCat starts with no UAC^) ...
powershell -NoProfile -Command "Start-Process -FilePath 'cmd.exe' -WorkingDirectory '%ROOT%' -ArgumentList '/k','%~f0' -Verb RunAs"
if errorlevel 1 (
  echo [x] elevation failed or you clicked No. Run this file again and answer Yes,
  echo     or right-click it and pick "Run as administrator".
  pause
)
exit /b

:run
title QQbot panel - closing this window stops the panel only
echo [i] starting panel: http://127.0.0.1:5151/
echo [i] the browser opens automatically; another port: set PANEL_PORT=5152
echo.

node "%ROOT%tools\panel\server.cjs" --open
set "CODE=%ERRORLEVEL%"

if not "%CODE%"=="0" (
  echo.
  echo [x] panel exited with code %CODE%
  pause
)
endlocal
