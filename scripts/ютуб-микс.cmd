@echo off
rem Микшер музыки YouTube: запускается планировщиком каждые 15 минут.
chcp 65001 >nul
cd /d "%~dp0.."
node scripts\ютуб-микс.mjs >> ytmix.log 2>&1
