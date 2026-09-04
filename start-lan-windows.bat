@echo off
REM ---------------------------------------------------------------------
REM Motion Run - LAN mode, one double-click.
REM
REM Runs the game server on this computer so the TV and phone talk to it
REM directly over your WiFi, with no trip out to the internet and back.
REM That is the whole point of LAN mode: it removes the round trip to the
REM cloud server, which is where most of the control lag comes from.
REM
REM Nothing to install beyond Node.js itself - the project has no
REM dependencies, and the HTTPS certificate is generated automatically the
REM first time you run this.
REM
REM Leave this window open while you play. Close it to stop the server.
REM ---------------------------------------------------------------------
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found on this computer.
  echo.
  echo   Install it from https://nodejs.org  ^(the "LTS" download^),
  echo   then double-click this file again.
  echo.
  pause
  exit /b 1
)

node server.js

REM If the server exits or crashes, hold the window open so the message is
REM readable instead of the window vanishing instantly.
echo.
echo   The server has stopped.
pause
