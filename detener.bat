@echo off
chcp 65001 >nul
echo Deteniendo el servidor de Optiflow...
powershell -NoProfile -Command ^
  "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*optiflow*server.js*' } | ForEach-Object { Write-Host ('  Deteniendo PID ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force }"
echo Listo.
timeout /t 3 >nul
