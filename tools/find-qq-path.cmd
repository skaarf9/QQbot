@echo off
REM Print the QQ path NapCat's launchers resolve from the registry
REM (HKLM\SOFTWARE\WOW6432Node\...\Uninstall\QQ -> UninstallString dir + QQ.exe).
setlocal EnableExtensions
set "RetString="
for /f "tokens=2*" %%a in ('reg query "HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\QQ" /v "UninstallString" 2^>nul') do set "RetString=%%~b"
if not defined RetString ( echo [x] no UninstallString for QQ in registry & exit /b 1 )
for %%a in ("%RetString%") do set "dir=%%~dpa"
set "QQPath=%dir%QQ.exe"
echo [i] QQ path = %QQPath%
if not exist "%QQPath%" ( echo [x] QQ.exe not found there & exit /b 1 )
for %%v in ("%QQPath%") do echo [i] QQ file version = %%~zv bytes
powershell -NoProfile -Command "(Get-Item '%QQPath%').VersionInfo.FileVersion" 2>nul
