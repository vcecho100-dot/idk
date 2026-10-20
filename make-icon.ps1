# Draws build/icon.png (256x256), the app icon used by the .exe.
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force "$PSScriptRoot\build" | Out-Null
$s = 256 / 512
$bmp = New-Object System.Drawing.Bitmap 256, 256
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
function RoundRect($x, $y, $w, $h, $r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath; $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90); $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90); $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure(); $p
}
function Brush($hex) { New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($hex)) }
function Face($hex, $points) {
  $pts = $points | ForEach-Object { New-Object System.Drawing.PointF ($_[0] * $s), ($_[1] * $s) }
  $g.FillPolygon((Brush $hex), [System.Drawing.PointF[]]$pts)
}
$g.FillPath((Brush '#0f1117'), (RoundRect 0 0 256 256 55))
$g.FillPath((Brush '#6e56cf'), (RoundRect 28 28 200 200 40))
Face '#ffffff' @(@(256, 120), @(376, 190), @(256, 260), @(136, 190))
Face '#d9d4ff' @(@(136, 190), @(256, 260), @(256, 400), @(136, 330))
Face '#b3a8ff' @(@(256, 260), @(376, 190), @(376, 330), @(256, 400))
$bmp.Save("$PSScriptRoot\build\icon.png", [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
