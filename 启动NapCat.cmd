@echo off
chcp 65001 >nul
REM ============================================================================
REM  Manual NapCat launcher - use this when the panel cannot start it.
REM
REM  Why it exists: starting NapCat needs administrator rights. When the panel
REM  (a non-elevated process) asks for elevation, the UAC prompt appears on the
REM  secure desktop and, if nobody answers it, Windows just leaves the request
REM  hanging - the panel then looks like it is "starting" forever. Running this
REM  file yourself puts the request in a normal console you can see and answer.
REM
REM  Pick 1 or 2 below:
REM    1 = Shell      inject into the installed QQ (F:\qq\QQ.exe). Needs the main
REM                   QQ closed first - QQNT is single instance, so injection
REM                   cannot attach while your own QQ is already running.
REM    2 = Framework  NapCat ships its own framework; it never touches the
REM                   installed QQ, so there is no single-instance conflict.
REM  Both need administrator rights, and both share the same config dir
REM  (login state and OneBot settings are reused, no re-scan needed).
REM ============================================================================

setlocal EnableExtensions
set "ROOT=%~dp0"
cd /d "%ROOT%"

echo Which NapCat variant?
echo   1  Shell      - inject into the installed QQ (close your own QQ first)
echo   2  Framework  - standalone framework, does not touch the installed QQ
echo.
choice /c 12 /n /m "Choose 1 or 2: "
if errorlevel 2 goto framework

echo.
echo [i] Shell: calling tools\start-napcat-shell.bat %*
echo [i] answer YES to the UAC prompt (the screen dims - that is normal)
call "%ROOT%tools\start-napcat-shell.bat" %*
goto done

:framework
echo.
echo [i] Framework: calling tools\start-napcat-framework.bat %*
echo [i] answer YES to the UAC prompt (the screen dims - that is normal)
call "%ROOT%tools\start-napcat-framework.bat" %*

:done
echo.
echo [i] launcher returned. Logs: NapCat.Shell\logs\ (and the panel NapCat tab).
pause
endlocal
