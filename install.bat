@echo off
chcp 65001 >nul
title OPTIFLOW - Instalacion del runtime
cd /d "%~dp0"

echo ================================================================
echo  Instalacion / reparacion del runtime portatil de Node.js
echo  (No requiere permisos de administrador ni instalacion global)
echo ================================================================
echo.

if exist ".runtime\node\node.exe" (
  echo [OK] Runtime ya instalado:
  ".runtime\node\node.exe" --version
  echo.
  pause
  exit /b 0
)

set VERSION=v24.21.0
set ZIP=%TEMP%\node-%VERSION%-win-x64.zip

echo Descargando Node.js %VERSION% (portatil, ~36 MB)...
powershell -NoProfile -Command ^
  "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://nodejs.org/dist/%VERSION%/node-%VERSION%-win-x64.zip' -OutFile '%ZIP%' -UseBasicParsing"

if not exist "%ZIP%" (
  echo [ERROR] No se pudo descargar el runtime. Verifique la conexion a internet.
  pause
  exit /b 1
)

echo Extrayendo en %cd%\.runtime ...
powershell -NoProfile -Command ^
  "Expand-Archive -Path '%ZIP%' -DestinationPath '%cd%\.runtime' -Force; Rename-Item -Path '%cd%\.runtime\node-%VERSION%-win-x64' -NewName 'node' -Force"

if not exist ".runtime\node\node.exe" (
  echo [ERROR] Fallo la extraccion del runtime.
  pause
  exit /b 1
)

echo.
echo [OK] Instalado:
".runtime\node\node.exe" --version
echo.

echo Instalando dependencias (pg) con npm...
".runtime\node\node.exe" "%~dp0.install\npm-cli.js" install --prefix "%~dp0."
if errorlevel 1 (
  echo [ERROR] Fallo npm install. Verifique la conexion a internet.
  pause
  exit /b 1
)

if not exist ".env" (
  echo.
  echo Creando .env de ejemplo...
  (
    echo SUPABASE_DB_URL=postgres://usuario:clave@host:6543/postgres
    echo OPTIFLOW_TZ=America/Argentina/Buenos_Aires
  ) > ".env"
  echo   Edite .env y ponga su cadena de Supabase (Dashboard - Database - URI).
)

echo.
echo Ya puede ejecutar start.bat
pause
