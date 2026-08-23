@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\ensure-dev-server.ps1" -Open
if errorlevel 1 pause
