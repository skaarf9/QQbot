$ErrorActionPreference = 'SilentlyContinue'
$route = 'D:\deepseek\QQbot\routes\astrbot'
for ($i = 0; $i -lt 3; $i++) {
  $procs = Get-CimInstance Win32_Process | Where-Object {
    ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($route, [StringComparison]::OrdinalIgnoreCase)) -or
    ($_.CommandLine -and $_.CommandLine -like "*$route*astrbot*")
  }
  if (-not $procs) { break }
  foreach ($p in $procs) {
    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
  }
  Start-Sleep -Milliseconds 800
}
