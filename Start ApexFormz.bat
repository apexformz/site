@echo off
title ApexFormz Launcher
cd /d "%~dp0"
if not exist "scripts\start-demo.ps1" (
    echo ApexFormz startup script was not found in this project folder.
    pause
    exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-demo.ps1" %*
set "LAUNCH_EXIT=%ERRORLEVEL%"
if not "%LAUNCH_EXIT%"=="0" (
    echo.
    echo ApexFormz could not start. Review the message above.
    pause
    exit /b %LAUNCH_EXIT%
)
echo.
echo You may close this window. ApexFormz will continue running.
pause
