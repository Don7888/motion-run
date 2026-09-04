@echo off
REM ---------------------------------------------------------------------
REM Motion Run - LAN mode, one double-click.
REM
REM Runs the game server on this computer, so the TV and the phone talk to
REM it directly across your own WiFi instead of going out to the cloud
REM server and back. That round trip is where most of the control lag
REM comes from, so this is the version to judge the responsiveness on.
REM
REM Nothing to install beyond Node.js itself - the project has no
REM dependencies, and the HTTPS certificate is generated automatically the
REM first time you run this.
REM
REM Leave this window open while you play. Close it to stop the server.
REM
REM Note: this file deliberately uses no multi-line ( ) blocks, and is
REM saved with Windows CRLF line endings, because cmd.exe parses both of
REM those unreliably in a file with Unix line endings.
REM ---------------------------------------------------------------------
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

node server.js

echo.
echo   The server has stopped.
pause
exit /b 0

:nonode
echo.
echo   Node.js was not found on this computer.
echo.
echo   Install it from https://nodejs.org - choose the "LTS" download,
echo   accept all the defaults, then double-click this file again.
echo.
pause
exit /b 1
