@echo off
chcp 65001 >nul
title OPTIFLOW - Control de Tiempos y Trazabilidad
cd /d "%~dp0"

echo ================================================================
echo    OPTIFLOW - Plataforma de Control de Tiempos y Trazabilidad
echo    Sector Placares - "De Otro Tiempo"
echo ================================================================
echo.

if not exist ".runtime\node\node.exe" (
  echo [ERROR] No se encontro el runtime de Node.js en .runtime\node
  echo         Ejecute install.bat para restaurar el runtime portatil.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\pg" (
  echo [ERROR] Faltan las dependencias (node_modules\pg).
  echo         Ejecute install.bat para instalarlas con npm.
  echo.
  pause
  exit /b 1
)

echo Iniciando servidor... abra el navegador si no se abre solo.
echo URL local : http://localhost:3000
echo Para detener: cierre esta ventana o ejecute detener.bat
echo.

".runtime\node\node.exe" "server\server.js"

echo.
echo El servidor se ha detenido.
pause
