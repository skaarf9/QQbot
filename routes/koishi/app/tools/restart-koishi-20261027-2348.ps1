# One-shot Koishi restart to activate chatluna-dsh-tool code changes (2026-10-27).
#
# Why a new script: the old restart-...-2156 run died at Start-Process because the
# process env block contained BOTH HTTPS_PROXY and https_proxy (PowerShell 5.1 builds
# a case-sensitive dictionary -> ArgumentException). Reset-ProxyEnvCase() below is the
# same idempotent fix already applied to the older scripts.
#
# Strategy:
#   0. record pre-flight state (5140 owner, koishi tree, watchdog, koishi.yml mtime/hash)
#   1. dedupe proxy env case duplicates (idempotent)
#   2. stop the DB watchdog first, so it cannot race us during the window
#   3. stop Koishi: taskkill /T WITHOUT /F first, then Stop-Process (supervisor first,
#      then descendants, then the port holder). Never taskkill /F. DSH is never touched:
#      the match requires BOTH "koishi" and "bin.js"/"lib\worker".
#   4. abort (no start) if 5140 is still held or any koishi node process survives
#   5. sqlite integrity_check with a read-write open (rolls back a hot journal); abort if not ok
#   6. restart the watchdog -> it starts Koishi as its child, so prod-err.log stays the
#      file it watches (DB self-heal keeps working after the restart)
#   7. if 5140 is not up in 100s -> fallback: direct start with cmd redirection
#   8. verify: exactly one LISTENING on 5140, one supervisor + one worker, no duplicates
#   9. confirm the plugin registered dsh_continue / background=notice in prod-err.log

$ErrorActionPreference = 'Continue'
$app = 'D:\deepseek\QQbot\routes\koishi\app'
$log = Join-Path $app 'restart-20261027-2348.log'
$watchdog = Join-Path $app 'tools\watch-koishi-db.cjs'
$wdOut = Join-Path $app 'tools\logs\watchdog.out.log'
$wdErr = Join-Path $app 'tools\logs\watchdog.err.log'
$prodErr = Join-Path $app 'tools\logs\prod-err.log'

$nodeExe = 'node'
try { $nodeExe = (Get-Command node -ErrorAction Stop).Source } catch {}

function Log([string]$m) {
  $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff') + '] ' + $m
  try { Add-Content -LiteralPath $log -Value $line -Encoding UTF8 } catch {}
}

function Get-Listen5140 {
  $hit = netstat -ano | Select-String 'TCP\s+\S+:5140\s+\S+\s+LISTENING\s+(\d+)'
  if ($hit) { return [int]$hit.Matches[0].Groups[1].Value }
  return $null
}

function Get-KoishiProcs {
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

function Get-DescendantPids([int]$root) {
  $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
  $found = New-Object System.Collections.Generic.List[int]
  $queue = New-Object System.Collections.Generic.Queue[int]
  $queue.Enqueue($root)
  while ($queue.Count -gt 0) {
    $cur = $queue.Dequeue()
    foreach ($p in $all) {
      if ($p.ParentProcessId -eq $cur -and $p.ProcessId -ne $PID) {
        $cid = [int]$p.ProcessId
        if (-not $found.Contains($cid)) { $found.Add($cid); $queue.Enqueue($cid) }
      }
    }
  }
  return $found
}

function Pids($list) { ($list | ForEach-Object { $_.ProcessId }) -join ',' }

# --- proxy env case dedupe (same fix as restart-...-2156.ps1 / -2245.ps1) ---
function Reset-ProxyEnvCase {
  $bases = @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY')
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
    if ($null -eq $upperVal -and $null -eq $lowerVal) { continue }
    if ($null -ne $upperVal -and $null -eq $lowerVal) { continue }
    if ($null -eq $upperVal -and $null -ne $lowerVal) {
      [Environment]::SetEnvironmentVariable($lower, $null, 'Process')
      [Environment]::SetEnvironmentVariable($base, $lowerVal, 'Process')
      $fixed++
      continue
    }
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
Log 'KOISHI RESTART STARTED (activate chatluna-dsh-tool: background notice + dsh_continue)'
Log ('script=' + $MyInvocation.MyCommand.Path + ' ps_pid=' + $PID + ' node=' + $nodeExe)

# ---------- 0. pre-flight ----------
$ko0 = Get-KoishiProcs
$wd0 = Get-WatchdogProcs
$yml = Join-Path $app 'koishi.yml'
$ymlHash = ''
try { $ymlHash = (Get-FileHash -LiteralPath $yml -Algorithm SHA256).Hash } catch {}
Log ('PRE port5140=' + (Get-Listen5140) + ' koishi=[' + (Pids $ko0) + '] watchdog=[' + (Pids $wd0) + ']')
Log ('PRE koishi.yml mtime=' + (Get-Item -LiteralPath $yml).LastWriteTime + ' size=' + (Get-Item -LiteralPath $yml).Length)
Log ('PRE koishi.yml sha256=' + $ymlHash)
foreach ($t in $ko0) { Log ('PRE  koishi pid=' + $t.ProcessId + ' ppid=' + $t.ParentProcessId + ' start=' + $t.CreationDate) }
foreach ($t in $wd0) { Log ('PRE  watchdog pid=' + $t.ProcessId + ' ppid=' + $t.ParentProcessId + ' start=' + $t.CreationDate) }

Push-Location $app
try {
  $ro = (& $nodeExe -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('data/koishi.db',{readOnly:true});console.log('RO '+JSON.stringify(d.prepare('pragma integrity_check').all()));d.close()" 2>&1 | Out-String).Trim()
} finally { Pop-Location }
Log ('PRE sqlite read-only integrity_check: ' + $ro)

# ---------- 1. proxy env dedupe ----------
$pBefore = @(cmd /c set | Select-String -Pattern '(?i)^(https?_proxy|all_proxy|no_proxy)=').Count
$pFixed = Reset-ProxyEnvCase
$pAfter = @(cmd /c set | Select-String -Pattern '(?i)^(https?_proxy|all_proxy|no_proxy)=').Count
Log ('proxy env dedupe: before=' + $pBefore + ' fixed=' + $pFixed + ' after=' + $pAfter)

# ---------- 2. stop watchdog (avoid racing during the restart window) ----------
foreach ($w in $wd0) {
  if (-not (Get-Process -Id $w.ProcessId -ErrorAction SilentlyContinue)) { continue }
  Stop-Process -Id $w.ProcessId -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 300
  Log ('stop watchdog pid=' + $w.ProcessId + ' gone=' + (-not (Get-Process -Id $w.ProcessId -ErrorAction SilentlyContinue)))
}
Start-Sleep -Seconds 1

# ---------- 3. stop koishi ----------
$ko = Get-KoishiProcs
$sup = $ko | Where-Object { $_.CommandLine -match 'koishi[\\/]bin\.js' } | Select-Object -First 1
if ($sup) {
  Log ('graceful: taskkill /PID ' + $sup.ProcessId + ' /T (no /F)')
  $out = (taskkill /PID $sup.ProcessId /T 2>&1 | Out-String).Trim()
  Log ('  exit=' + $LASTEXITCODE + ' out=' + $out)
}
Start-Sleep -Seconds 2

$alive = Get-KoishiProcs
if ($alive.Count -gt 0) {
  Log ('still alive [' + (Pids $alive) + '] -> Stop-Process (never taskkill /F), supervisor first')
  if ($sup) {
    Stop-Process -Id $sup.ProcessId -Force -ErrorAction SilentlyContinue
    Log ('  Stop-Process supervisor ' + $sup.ProcessId)
  }
  Start-Sleep -Seconds 1
  foreach ($p in (Get-KoishiProcs)) {
    foreach ($d in (Get-DescendantPids ([int]$p.ProcessId))) {
      Stop-Process -Id $d -Force -ErrorAction SilentlyContinue
      Log ('  Stop-Process descendant ' + $d)
    }
  }
  foreach ($p in (Get-KoishiProcs)) {
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    Log ('  Stop-Process koishi pid=' + $p.ProcessId)
  }
} else {
  Log 'graceful close worked; nothing to force'
}

# ---------- 4. wait for a clean state (abort instead of risking two instances) ----------
$deadline = (Get-Date).AddSeconds(25)
$lp = Get-Listen5140
while ($lp -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500; $lp = Get-Listen5140 }
if ($lp) { Log ('ABORT: port 5140 still held by pid=' + $lp + ' -- NOT starting anything'); exit 1 }
Log 'port 5140: free'
$left = Get-KoishiProcs
if ($left.Count -gt 0) { Log ('ABORT: koishi processes still alive [' + (Pids $left) + '] -- NOT starting anything'); exit 1 }
Log 'no koishi node process left'

# ---------- 5. sqlite integrity check (read-write open rolls back a hot journal) ----------
Push-Location $app
try {
  $rw = (& $nodeExe -e "const fs=require('fs');const p='data/koishi.db';const had=fs.existsSync(p+'-journal');const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(p);const ic=d.prepare('pragma integrity_check').all();d.close();console.log('RW '+JSON.stringify({had,integrity:ic[0]&&ic[0].integrity_check,journalAfter:fs.existsSync(p+'-journal')}))" 2>&1 | Out-String).Trim()
  $rwCode = $LASTEXITCODE
} finally { Pop-Location }
Log ('sqlite rw integrity_check exit=' + $rwCode + ' output=' + $rw)
if ($rw -notmatch '"integrity":"ok"') { Log 'ABORT: integrity_check not ok -- NOT starting koishi'; exit 1 }

# ---------- 6. restart watchdog -> it brings Koishi up (keeps prod-err.log watched) ----------
$ok = $false
try {
  $w2 = Start-Process -FilePath $nodeExe `
    -ArgumentList @('tools/watch-koishi-db.cjs', '--interval', '20', '--cooldown', '120') `
    -WorkingDirectory $app -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $wdOut -RedirectStandardError $wdErr -ErrorAction Stop
  Log ('started watchdog pid=' + $w2.Id + ' -> it will start Koishi')
} catch {
  Log ('WARN: watchdog Start-Process failed: ' + ($_ | Out-String).Trim())
}

$deadline = (Get-Date).AddSeconds(100)
while ((Get-Date) -lt $deadline) {
  $lp = Get-Listen5140
  if ($lp) { Log ('port 5140 LISTENING pid=' + $lp + ' (via watchdog)'); $ok = $true; break }
  Start-Sleep -Seconds 2
}

# ---------- 7. fallback: direct start (cmd owns the redirection -> no env dictionary) ----------
if (-not $ok) {
  Log 'watchdog did not bring Koishi up in 100s -> fallback: direct start (append to prod-err.log)'
  $cmdLine = '"' + $nodeExe + '" node_modules/koishi/bin.js start >> "' + $prodErr + '" 2>&1'
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $env:ComSpec
    $psi.Arguments = '/c "' + $cmdLine + '"'
    $psi.WorkingDirectory = $app
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    Log ('fallback start issued, cmd pid=' + $p.Id)
  } catch {
    Log ('ABORT: fallback start failed: ' + ($_ | Out-String).Trim())
    exit 1
  }
  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline) {
    $lp = Get-Listen5140
    if ($lp) { Log ('port 5140 LISTENING pid=' + $lp + ' (fallback)'); $ok = $true; break }
    Start-Sleep -Seconds 2
  }
}

if (-not $ok) { Log 'ABORT: 5140 never came up (see watchdog.out.log / prod-err.log)'; exit 1 }

# ---------- 8. duplicate guard ----------
$ko1 = Get-KoishiProcs
$sups = @($ko1 | Where-Object { $_.CommandLine -match 'koishi[\\/]bin\.js' })
$works = @($ko1 | Where-Object { $_.CommandLine -match 'koishi[\\/]lib[\\/]worker' })
$holder = Get-Listen5140
Log ('post-start: 5140=' + $holder + ' supervisors=[' + (Pids $sups) + '] workers=[' + (Pids $works) + ']')
if ($sups.Count -gt 1 -or $works.Count -gt 1) {
  Log 'WARN: duplicate koishi instances detected -> keeping only the tree that holds 5140'
  $keep = $null
  foreach ($s in $sups) {
    $desc = @(Get-DescendantPids ([int]$s.ProcessId))
    if ($desc -contains [int]$holder) { $keep = $s; break }
  }
  if (-not $keep -and $sups.Count) { $keep = $sups[0] }
  foreach ($s in $sups) {
    if ($keep -and $s.ProcessId -eq $keep.ProcessId) { continue }
    Stop-Process -Id $s.ProcessId -Force -ErrorAction SilentlyContinue
    Log ('  stopped duplicate supervisor ' + $s.ProcessId)
  }
  Start-Sleep -Seconds 2
  $ko2 = Get-KoishiProcs
  $sups2 = @($ko2 | Where-Object { $_.CommandLine -match 'koishi[\\/]bin\.js' })
  $works2 = @($ko2 | Where-Object { $_.CommandLine -match 'koishi[\\/]lib[\\/]worker' })
  Log ('after dup cleanup: supervisors=[' + (Pids $sups2) + '] workers=[' + (Pids $works2) + '] 5140=' + (Get-Listen5140))
} else {
  Log 'duplicate guard: exactly one supervisor + one worker'
}

# ---------- 9. confirm the plugin registered the new tools ----------
$hit = $false
for ($i = 0; $i -lt 20; $i++) {
  if (Test-Path -LiteralPath $prodErr) {
    # prod-err.log 是 UTF-8；PS 5.1 的 Get-Content 默认按 ANSI 读，中文会变乱码 -> 会误报"未注册"
    $tail = Get-Content -LiteralPath $prodErr -Tail 400 -Encoding UTF8 -ErrorAction SilentlyContinue
    $line = $tail | Select-String 'DSH 工具已注册' | Select-Object -Last 1
    if ($line) {
      Log ('plugin registration line: ' + $line.Line.Trim())
      $hit = ($line.Line -match 'dsh_continue' -and $line.Line -match '后台=')
      break
    }
  }
  Start-Sleep -Seconds 2
}
if ($hit) {
  Log 'CHECK OK: dsh_continue registered + background mode logged'
} else {
  Log 'WARN: registration line not found (or lacks dsh_continue/后台=) in prod-err.log last 400 lines'
}

$finalKo = @(Get-KoishiProcs)
$finalWd = @(Get-WatchdogProcs)
Log ('FINAL 5140=' + (Get-Listen5140) + ' koishi=[' + (Pids $finalKo) + '] watchdog=[' + (Pids $finalWd) + ']')
foreach ($t in $finalKo) { Log ('  alive pid=' + $t.ProcessId + ' ppid=' + $t.ParentProcessId + ' start=' + $t.CreationDate) }

if ($ok -and (Get-Listen5140)) { Log 'RESTART RESULT: OK' } else { Log 'RESTART RESULT: FAILED' }
Log '============================================================'
