@echo off
title Bot JNE Super Ringan
color 0A

echo ========================================================
echo         SISTEM AUDIT JNE - BOT WHATSAPP LITE
echo ========================================================
echo.
echo Memulai mesin Node.js...
echo.

:start
node index.js
echo.
echo [!] Bot terhenti atau crash. Memulai ulang dalam 5 detik...
timeout /t 5 /nobreak >nul
goto start
