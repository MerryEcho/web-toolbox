@echo off
REM ============================================================
REM YT-DLP Server Launcher
REM Called by yt-dlp-server:// protocol handler
REM Single-shot mode: server exits after one download
REM ============================================================

REM Only skip launch if the REAL yt backend /health responds
powershell -NoProfile -Command "try { $r = Invoke-RestMethod -Uri http://127.0.0.1:8765/health -TimeoutSec 2; if ($r.status -eq 'ok' -and $r.'yt-dlp') { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
if %errorlevel% equ 0 exit 0

REM Start server (minimized window, single-shot mode)
start /min "" python "%~dp0yt_download_server.py"

exit 0
