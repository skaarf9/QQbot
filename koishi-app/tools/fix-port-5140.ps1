# fix-port-5140.ps1 -- reclaim TCP 127.0.0.1:5140 from the Windows/Hyper-V port
# reservation that made listen() fail with EACCES, which in turn made Koishi's
# server plugin throw "No open ports available", dispose the `server` service and
# take every plugin that requires it (game-auto -> /maa.* /endfield.*) down with it.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\fix-port-5140.ps1
#
# Self-elevating (UAC), ASCII only so Windows PowerShell 5.1 can read it, and it
# verifies the port after every step; it degrades to the next trick only if the
# previous one did not work, and it ALWAYS leaves the winnat service running.
# Everything is appended to tools\logs\fix-port-5140.log.

$Port       = 5140
$BlockStart = 5041
$BlockCount = 100
$LogPath    = Join-Path $PSScriptRoot 'logs\fix-port-5140.log'

function Write-Log([string]$Message) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Write-Host $line
  try { Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8 } catch { }
}

# Can we actually bind 127.0.0.1:<port> right now?
function Test-Bind([int]$P) {
  try {
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Parse('127.0.0.1'), $P)
    $listener.Start()
    $listener.Stop()
    return $true
  } catch {
    return $false
  }
}

function Show-Ranges {
  Write-Log '--- excluded port ranges (tcp) ---'
  $lines = & netsh int ipv4 show excludedportrange protocol=tcp 2>&1
  foreach ($l in $lines) { Write-Log ('  ' + $l) }
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin  = (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host 'not elevated -- relaunching with a UAC prompt...'
  Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath
  )
  exit 0
}

$dir = Split-Path -Parent $LogPath
if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

Write-Log ('=== fix-port-5140 start (elevated, pid {0}) ===' -f $PID)
Show-Ranges

if (Test-Bind $Port) {
  Write-Log ('port {0}: bindable already -- nothing to do' -f $Port)
  Write-Log 'VERDICT: ALREADY-OK'
  exit 0
}
Write-Log ('port {0}: bind FAILED -- trying to release it' -f $Port)

$fixed      = $false
$natStopped = $false

try {
  # step 1: drop the administered exclusion that covers our port
  Write-Log ('step 1: netsh delete excludedportrange {0}+{1}' -f $BlockStart, $BlockCount)
  $out = & netsh int ipv4 delete excludedportrange protocol=tcp "startport=$BlockStart" "numberofports=$BlockCount" 2>&1
  foreach ($l in $out) { Write-Log ('  ' + $l) }
  if (Test-Bind $Port) { $fixed = $true } else { Write-Log 'step 1 did not free the port' }

  # step 2: WinNAT may still be holding the sockets itself. Restart it while our
  # own 1-port reservation is in the list, so it skips 5140 when it re-claims.
  if (-not $fixed) {
    Write-Log 'step 2: net stop winnat -> reserve our port -> net start winnat'
    $out = & net stop winnat 2>&1
    foreach ($l in $out) { Write-Log ('  ' + $l) }
    $natStopped = $true
    if (Test-Bind $Port) { Write-Log 'port is free while winnat is stopped' }
    $out = & netsh int ipv4 add excludedportrange protocol=tcp "startport=$Port" numberofports=1 store=persistent 2>&1
    foreach ($l in $out) { Write-Log ('  ' + $l) }
    $out = & net start winnat 2>&1
    foreach ($l in $out) { Write-Log ('  ' + $l) }
    $natStopped = $false
    Start-Sleep -Seconds 2
    if (Test-Bind $Port) { $fixed = $true }
    if (-not $fixed) {
      Write-Log 'our own reservation also blocks the bind -- removing it again'
      $out = & netsh int ipv4 delete excludedportrange protocol=tcp "startport=$Port" numberofports=1 2>&1
      foreach ($l in $out) { Write-Log ('  ' + $l) }
      if (Test-Bind $Port) { $fixed = $true }
    }
  }
} finally {
  if ($natStopped) {
    Write-Log 'finally: winnat was left stopped -- starting it again'
    $out = & net start winnat 2>&1
    foreach ($l in $out) { Write-Log ('  ' + $l) }
  }
}

Show-Ranges
if ($fixed) {
  Write-Log ('RESULT: 127.0.0.1:{0} is bindable now' -f $Port)
  Write-Log 'VERDICT: FIXED'
  exit 0
}
Write-Log ('RESULT: 127.0.0.1:{0} is STILL blocked' -f $Port)
Write-Log 'VERDICT: STILL-BLOCKED'
exit 1
