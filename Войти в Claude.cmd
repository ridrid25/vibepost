@echo off
chcp 65001 >nul
title Вход в Claude
cd /d "%USERPROFILE%\Downloads\Обучение\CLAUD\Отложенный постинг (рассылка) в ТГ"
echo.
echo   ВХОД В CLAUDE
echo.
echo   Сейчас откроется Claude. Он спросит про вход —
echo   согласитесь и войдите тем же аккаунтом, что и в приложении.
echo.
echo   Когда увидите приглашение к разговору — вход готов,
echo   это окно можно закрыть крестиком.
echo.
pause
claude
