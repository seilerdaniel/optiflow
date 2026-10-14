# Genera los iconos PWA de Optiflow (PNG) usando System.Drawing de .NET.
# Uso: powershell -NoProfile -ExecutionPolicy Bypass -File server\tools\gen-iconos.ps1
# Salida: public/icons/*.png

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$salida = Join-Path $PSScriptRoot '..\..\public\icons'
New-Item -ItemType Directory -Force -Path $salida | Out-Null

function Nuevo-Lienzo([int]$tam) {
  $bmp = New-Object System.Drawing.Bitmap($tam, $tam)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  return @($bmp, $g)
}

function Dibujar-Icono([int]$tam, [string]$ruta, [bool]$maskable) {
  $lienzo = Nuevo-Lienzo $tam
  $bmp = $lienzo[0]; $g = $lienzo[1]

  # Fondo: relleno degradado azul industrial oscuro (si maskable, cubre todo
  # el lienzo para que el SO recorte el "safe area" circular).
  $rect = New-Object System.Drawing.Rectangle(0, 0, $tam, $tam)
  $degradado = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 15, 47, 79),    # #0f2f4f
    [System.Drawing.Color]::FromArgb(255, 9, 30, 52),     # más oscuro
    [System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal
  )
  if (-not $maskable) {
    # Esquinas redondeadas con transparencia fuera del área (el maskable
    # en cambio cubre todo el lienzo porque el SO recorta el "safe area").
    $rad = [int]($tam * 0.20)
    $rutaGraf = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $rad * 2
    $rutaGraf.AddArc(0, 0, $d, $d, 180, 90)
    $rutaGraf.AddArc($tam - $d, 0, $d, $d, 270, 90)
    $rutaGraf.AddArc($tam - $d, $tam - $d, $d, $d, 0, 90)
    $rutaGraf.AddArc(0, $tam - $d, $d, $d, 90, 90)
    $rutaGraf.CloseFigure()
    $g.SetClip($rutaGraf)
    $g.FillRectangle($degradado, $rect)
    $g.ResetClip()
    $rutaGraf.Dispose()
  } else {
    $g.FillRectangle($degradado, $rect)
  }

  # Acento: círculo azul claro detrás del monograma.
  $cx = [int]($tam / 2); $cy = [int]($tam / 2)
  if ($maskable) { $factor = 0.30 } else { $factor = 0.34 }
  $r = [int]($tam * $factor)
  $pincelCirculo = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 29, 111, 209)) # #1d6fd1
  $g.FillEllipse($pincelCirculo, ($cx - $r), ($cy - $r), ($r * 2), ($r * 2))

  # Monograma "OF" en blanco, centrado.
  $fuente = New-Object System.Drawing.Font('Segoe UI', [float]($tam * 0.34), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $pincelTexto = [System.Drawing.Brushes]::White
  $formato = New-Object System.Drawing.StringFormat
  $formato.Alignment = [System.Drawing.StringAlignment]::Center
  $formato.LineAlignment = [System.Drawing.StringAlignment]::Center
  $g.DrawString('OF', $fuente, $pincelTexto, (New-Object System.Drawing.RectangleF(0, 0, $tam, $tam)), $formato)

  $bmp.Save($ruta, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose(); $pincelCirculo.Dispose(); $fuente.Dispose(); $degradado.Dispose()
  Write-Host "  [OK] $ruta ($tam x $tam)"
}

Write-Host 'Generando iconos PWA de Optiflow...'
Dibujar-Icono 192 (Join-Path $salida 'icon-192.png') $false
Dibujar-Icono 512 (Join-Path $salida 'icon-512.png') $false
Dibujar-Icono 512 (Join-Path $salida 'icon-maskable-512.png') $true
Dibujar-Icono 180 (Join-Path $salida 'apple-touch-icon.png') $true
Write-Host 'Listo.'
