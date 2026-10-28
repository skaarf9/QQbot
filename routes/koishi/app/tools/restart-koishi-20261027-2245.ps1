# Detached Koishi restart (2026-10-27 2245)
# Purpose: activate the chatluna_vision service + SC-VISION patch (sticker judge reads text only).
# NOTE: ASCII only on purpose -- this box's `pwsh` is PowerShell 5.1, which reads BOM-less
#       UTF-8 files as ANSI and would mangle CJK quotes.
#
# Sequence:
#   0. sleep 30s (caller returns first so QQ gets the "going offline" reply)
#   1. stop watchdog (otherwise its 20s tick races us and we end up with two instances)
#   2. stop Koishi: taskkill /T without /F first, then Stop-Process (never taskkill /F)
#   3. wait for port 5140 to be free
#   4. node tools/db-integrity-check.cjs  (rolls back hot journal + integrity_check)
#   5. restart watchdog -> it brings Koishi up through its normal path (appends to
#      tools/logs/prod-err.log, so the DB self-heal watchdog keeps working)
#   6. wait for 5140 LISTENING; after 90s, fallback to a direct start
#   7. verify port / process tree / watchdog

$ErrorActionPreference = 'Continue'
$app = 'D:\deepseek\QQbot\routes\koishi\app'
$log = Join-Path $app 'restart-20261027-2245.log'
$nodeExe = 'node'
try { $nodeExe = (Get-Command node -ErrorAction Stop).Source } catch {}

function Log {
  param([string]$msg)
  $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff') + '] ' + $msg
  try { Add-Content -LiteralPath $log -Value $line -Encoding UTF8 } catch {}
}

function Get-KoishiNodeProcs {
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
      $_.CommandLine -and (
        $_.CommandLine -match 'koishi[\\/]bin\.js' -or
        $_.CommandLine -match 'koishi[\\/]lib[\\/]worker'
      )
    })
}

function Get-WatchdogProcs {
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
      $_.CommandLine -and $_.CommandLine -match 'watch-koishi-db'
    })
}

function Get-Listen5140 {
  $hit = netstat -ano | Select-String 'TCP\s+\S+:5140\s+\S+\s+LISTENING\s+(\d+)'
  if ($hit) { return [int]$hit.Matches[0].Groups[1].Value }
  return $null
}

function Pids { param($list) ($list | ForEach-Object { $_.ProcessId }) -join ',' }

# ---------------------------------------------------------------------------
# Proxy env case de-duplication (PowerShell 5.1 compatibility). Idempotent.
#
# Why: a Windows process env block may contain BOTH HTTPS_PROXY and https_proxy
# (bash exports both). Windows PowerShell 5.1's Start-Process copies that block
# into a CASE-SENSITIVE dictionary and throws
#   Item has already been added. Key in dictionary: 'HTTPS_PROXY'
#   Key being added: 'https_proxy'
# which ABORTs the whole script -- that is exactly how the 2026-10-27 21:55 run
# died at its start step. Keep one canonical UPPER-CASE entry per proxy name,
# drop the other case form. No duplicates -> no-op; safe to call repeatedly.
function Reset-ProxyEnvCase {
  $bases = @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY')
  # `cmd /c set` prints the raw block WITH its original case; $env: and
  # GetEnvironmentVariables() cannot tell HTTPS_PROXY from https_proxy apart.
  $block = @(cmd /c set)
  $fixed = 0
  foreach ($base in $bases) {
    $lower = $base.ToLower()
    $upperVal = $null
    $lowerVal = $null
    foreach ($line in $block) {
      if ($null -eq $upperVal -and $line.StartsWith($base + '=', [StringComparison]::Ordinal)) {
        $upperVal = $line.Substring($base.Length + 1)
      } elseif ($null -eq $lowerVal -and $line.StartsWith($lower + '=', [StringComparison]::Ordinal)) {
        $lowerVal = $line.Substring($lower.Length + 1)
      }
    }
    if ($null -eq $upperVal -and $null -eq $lowerVal) { continue }   # not set: skip
    if ($null -ne $upperVal -and $null -eq $lowerVal) { continue }   # upper-case only: canonical
    if ($null -eq $upperVal -and $null -ne $lowerVal) {
      # lower-case only: rewrite as the canonical upper-case name
      [Environment]::SetEnvironmentVariable($lower, $null, 'Process')
      [Environment]::SetEnvironmentVariable($base, $lowerVal, 'Process')
      $fixed++
      continue
    }
    # both cases present: keep the upper-case value, drop the lower-case entry.
    # Win32 SetEnvironmentVariable is case-insensitive and removes one entry per
    # call, so loop (cap 4) until the name is gone, then re-add the upper-case one.
    for ($i = 0; $i -lt 4; $i++) {
      if ($null -eq [Environment]::GetEnvironmentVariable($lower, 'Process')) { break }
      [Environment]::SetEnvironmentVariable($lower, $null, 'Process')
    }
    if ($null -ne $upperVal -and $upperVal -ne '') {
      [Environment]::SetEnvironmentVariable($base, $upperVal, 'Process')
    }
    $fixed++
  }
  return $fixed
}

Log '============================================================'
Log 'RESTART STARTED (detached): chatluna_vision service + SC-VISION'
Log ('script=' + $MyInvocation.MyCommand.Path + ' ps_pid=' + $PID + ' node=' + $nodeExe)

# Dedupe BEFORE any Start-Process is used below (idempotent; logged).
$proxyBefore = @(cmd /c set | Select-String -Pattern '(?i)^(https?_proxy|all_proxy|no_proxy)=').Count
$proxyFixed = Reset-ProxyEnvCase
$proxyAfter = @(cmd /c set | Select-String -Pattern '(?i)^(https?_proxy|all_proxy|no_proxy)=').Count
Log ('proxy env dedupe: before=' + $proxyBefore + ' fixed=' + $proxyFixed + ' after=' + $proxyAfter)

Log '--- deliberate delay 30s: caller returns first ---'
Start-Sleep -Seconds 30

$ko = Get-KoishiNodeProcs
$wd = Get-WatchdogProcs
Log ('snapshot: koishi=[' + (Pids $ko) + '] watchdog=[' + (Pids $wd) + '] port5140=' + (Get-Listen5140))

foreach ($w in $wd) {
  Stop-Process -Id $w.ProcessId -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 300
  $gone = -not (Get-Process -Id $w.ProcessId -ErrorAction SilentlyContinue)
  Log ('stopped watchdog pid=' + $w.ProcessId + ' gone=' + $gone)
}
Start-Sleep -Seconds 1

$sup = $ko | Where-Object { $_.CommandLine -match 'koishi[\\/]bin\.js' } | Select-Object -First 1
if ($sup) {
  Log ('graceful: taskkill /PID ' + $sup.ProcessId + ' /T (no /F)')
  $out = (taskkill /PID $sup.ProcessId /T 2>&1 | Out-String).Trim()
  Log ('  exit=' + $LASTEXITCODE + ' out=' + $out)
}
Start-Sleep -Seconds 2

$alive = Get-KoishiNodeProcs
if ($alive.Count -gt 0) {
  Log ('still alive [' + (Pids $alive) + '] -> Stop-Process, supervisor first')
  foreach ($t in $alive) {
    if ($t.CommandLine -match 'koishi[\\/]bin\.js') {
      Stop-Process -Id $t.ProcessId -Force -ErrorAction SilentlyContinue
      Log ('  Stop-Process supervisor ' + $t.ProcessId)
    }
  }
  Start-Sleep -Seconds 1
  foreach ($t in (Get-KoishiNodeProcs)) {
    Stop-Process -Id $t.ProcessId -Force -ErrorAction SilentlyContinue
    Log ('  Stop-Process ' + $t.ProcessId)
  }
}

$deadline = (Get-Date).AddSeconds(25)
$lp = Get-Listen5140
while ($lp -and (Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
  $lp = Get-Listen5140
}
if ($lp) {
  Log ('WARN: port 5140 still held by pid=' + $lp + ' -- trying to start anyway')
} else {
  Log 'port 5140: free'
}
Log ('leftover koishi procs=[' + (Pids (Get-KoishiNodeProcs)) + ']')

Push-Location $app
try { $rr = (& $nodeExe 'tools/db-integrity-check.cjs' 2>&1 | Out-String).Trim() } finally { Pop-Location }
Log ('integrity_check: ' + $rr)

$wdOut = Join-Path $app 'tools\logs\watchdog.out.log'
$wdErr = Join-Path $app 'tools\logs\watchdog.err.log'
try {
  $w2 = Start-Process -FilePath $nodeExe -ArgumentList @('tools/watch-koishi-db.cjs', '--interval', '20', '--cooldown', '120') -WorkingDirectory $app -WindowStyle Hidden -PassThru -RedirectStandardOutput $wdOut -RedirectStandardError $wdErr -ErrorAction Stop
  Log ('started watchdog pid=' + $w2.Id)
} catch {
  Log ('WARN: watchdog start failed: ' + ($_ | Out-String).Trim())
}

$deadline = (Get-Date).AddSeconds(90)
$ok = $false
while ((Get-Date) -lt $deadline) {
  $lp = Get-Listen5140
  if ($lp) { Log ('port 5140 LISTENING pid=' + $lp); $ok = $true; break }
  Start-Sleep -Seconds 2
}

if (-not $ok) {
  Log 'watchdog did not bring it up in 90s -> fallback: direct start (append to prod-err.log)'
  $cmd = '"' + $nodeExe + '" node_modules/koishi/bin.js start >> "tools\logs\prod-err.log" 2>&1'
  try {
    Start-Process -FilePath $env:ComSpec -ArgumentList @('/c', $cmd) -WorkingDirectory $app -WindowStyle Hidden | Out-Null
    Log 'fallback start issued'
  } catch {
    Log ('fallback failed: ' + ($_ | Out-String).Trim())
  }
  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline) {
    $lp = Get-Listen5140
    if ($lp) { Log ('port 5140 LISTENING pid=' + $lp + ' (fallback)'); $ok = $true; break }
    Start-Sleep -Seconds 2
  }
}

$ko2 = Get-KoishiNodeProcs
$wd2 = Get-WatchdogProcs
Log ('final: 5140=' + (Get-Listen5140) + ' koishi=[' + (Pids $ko2) + '] watchdog=[' + (Pids $wd2) + ']')
foreach ($t in $ko2) { Log ('  alive pid=' + $t.ProcessId + ' cmd=' + $t.CommandLine.Substring(0, [Math]::Min(90, $t.CommandLine.Length))) }
if ($ok) { Log 'RESTART DONE (ok)' } else { Log 'RESTART DONE (FAILED: 5140 not listening)' }
Log '============================================================'
