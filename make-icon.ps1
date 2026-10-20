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
$g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#0f1117'))), (RoundRect 0 0 256 256 55))
$g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#30a46c'))), (RoundRect 28 28 200 200 40))
$pts = @(@(290, 90), @(150, 290), @(250, 290), @(220, 422), @(362, 216), @(262, 216)) | ForEach-Object { New-Object System.Drawing.PointF ($_[0] * $s), ($_[1] * $s) }
$g.FillPolygon([System.Drawing.Brushes]::White, [System.Drawing.PointF[]]$pts)
$bmp.Save("$PSScriptRoot\build\icon.png", [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
