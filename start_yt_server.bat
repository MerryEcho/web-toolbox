@echo off
REM ============================================================
REM YT-DLP Server Launcher
REM Called by yt-dlp-server:// protocol handler
REM Single-shot mode: server exits after one download
REM ============================================================

REM Check if server is already running on port 8765
netstat -ano 2>nul | findstr ":8765" | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 exit 0

REM Start server (minimized window, single-shot mode)
start /min "" python "%~dp0yt_download_server.py"

exit 0
