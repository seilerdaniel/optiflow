@echo off
chcp 65001 >nul
title OPTIFLOW - Reinicio de datos
cd /d "%~dp0"

echo ================================================================
echo  REINICIO DE DATOS DE OPTIFLOW
echo  Se detendra el servidor y se borraran TODOS los datos
echo  (OTs y registros de tiempos). La base se recrea vacia con
echo  los 11 sectores y 3 OTs de ejemplo en el proximo arranque.
echo ================================================================
echo.
choice /c SN /n /m "  Desea continuar? [S]=Si  [N]=No : "
if errorlevel 2 (
  echo Cancelado.
  timeout /t 2 >nul
  exit /b 0
)

echo.
echo Deteniendo el servidor...
powershell -NoProfile -Command ^
  "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*optiflow*server.js*' -or $_.CommandLine -like '*server\\server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

timeout /t 1 >nul

echo Borrando datos...
del /f /q "data\*.db" 2>nul
del /f /q "data\*.db-wal" 2>nul
del /f /q "data\*.db-shm" 2>nul

echo.
echo [OK] Datos borrados. Ejecute start.bat para volver a arrancar.
pause
