@echo off
chcp 65001 >nul
title VibePost - priemnik rolikov
cd /d "%~dp0"
node scripts\watch-videos.mjs
echo.
echo Programma ostanovlena. Nazhmite lyubuyu klavishu.
pause >nul
