@echo off
rem ASCII only inside .cmd files: Cyrillic breaks in the OEM codepage.
rem Stops the video receiver started by "Priyomnik.vbs" / autostart.
powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*watch-videos*' }; if ($p) { $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Write-Host 'Receiver stopped.' } else { Write-Host 'Receiver was not running.' }"
timeout /t 3 >nul
