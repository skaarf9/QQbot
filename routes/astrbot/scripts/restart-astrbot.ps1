param([int]$Delay = 15)

$ErrorActionPreference = 'SilentlyContinue'
Start-Sleep -Seconds ([Math]::Max(1, $Delay))

$route = 'D:\deepseek\QQbot\routes\astrbot'
$app = Join-Path $route 'app'
$bin = Join-Path $route 'bin\astrbot.exe'
$logDir = Join-Path $route 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$outLog = Join-Path $logDir 'astrbot-run.log'
$errLog = Join-Path $logDir 'astrbot-restart.err.log'

function Write-SelfextLog([string]$text) {
  $line = (@{ at = (Get-Date).ToString('o'); action = 'restart'; text = $text } | ConvertTo-Json -Compress)
  Add-Content -LiteralPath (Join-Path $logDir 'selfext.log') -Value $line -Encoding UTF8
}

Write-SelfextLog "delay=$Delay begin"

# 只杀 routes\astrbot 下的 AstrBot 进程（父 astrbot.exe + 子 python.exe），不碰 DSH / Koishi
for ($i = 0; $i -lt 3; $i++) {
  $procs = Get-CimInstance Win32_Process | Where-Object {
    ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($route, [StringComparison]::OrdinalIgnoreCase)) -or
    ($_.CommandLine -and $_.CommandLine -like "*$route*astrbot*")
  }
  if (-not $procs) { break }
  foreach ($p in $procs) {
    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
  }
  Start-Sleep -Milliseconds 700
}

Start-Sleep -Seconds 2
$runCmd = Join-Path $route 'scripts\run-astrbot.cmd'
if (-not (Test-Path -LiteralPath $runCmd)) {
  Write-SelfextLog "missing launcher: $runCmd"
  exit 1
}

try {
  # 不用 Start-Process：DSH 环境里同时有 NO_PROXY / no_proxy，PowerShell 复制环境会报
  # “Item has already been added”。.NET 的 shell-exec 启动不经过那个字典。
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $runCmd
  $psi.UseShellExecute = $true
  $psi.WindowStyle = 'Hidden'
  [System.Diagnostics.Process]::Start($psi) | Out-Null
  Write-SelfextLog 'started'
} catch {
  Write-SelfextLog "start failed: $($_.Exception.Message)"
}
