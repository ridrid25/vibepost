@echo off
chcp 65001 >nul
title Ролики в VibePost — папка-приёмник
cd /d "%~dp0"
node scripts\watch-videos.mjs
echo.
echo Программа остановлена. Нажмите любую клавишу, чтобы закрыть окно.
pause >nul
