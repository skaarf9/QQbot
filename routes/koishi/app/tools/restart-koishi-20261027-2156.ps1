# Detached Koishi restart: apply koishi.yml chatluna-dsh-tool:dsht01 groups = ['1040488785']
# Sequence: sleep 10s -> stop supervisor+worker -> wait port 5140 free -> node:sqlite integrity_check
#           -> start `node node_modules/koishi/bin.js start` -> wait for 5140 LISTENING
# No `taskkill /F` anywhere. Every step is appended to restart-20261027-2156.log.

$ErrorActionPreference = 'Continue'
$app = 'D:\deepseek\QQbot\routes\koishi\app'
$log = 'D:\deepseek\QQbot\routes\koishi\app\restart-20261027-2156.log'

function Log([string]$msg) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'), $msg
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

function Get-Listen5140 {
  $hit = netstat -ano | Select-String 'TCP\s+\S+:5140\s+\S+\s+LISTENING\s+(\d+)'
  if ($hit) { return [int]$hit.Matches[0].Groups[1].Value }
  return $null
}

# ---------------------------------------------------------------------------
# 代理环境变量大小写去重（PowerShell 5.1 兼容），幂等
#
# 为什么必须要有这段：Windows 进程环境块本身允许 HTTPS_PROXY 和 https_proxy
# 同时存在（bash 里两个都 export 就是这样）。而 Windows PowerShell 5.1 的
# Start-Process（以及 env: 提供程序）会把整个环境块塞进一个【区分大小写】的
# 字典，撞名就抛
#   Item has already been added. Key in dictionary: 'HTTPS_PROXY'
#   Key being added: 'https_proxy'
# 并让脚本 ABORT —— 2026-10-27 21:55 那次就是在启动那一步这么死的。
#
# 做法：对 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY 四个名字，
# 先记下有效值（优先大写形式的），再把两种大小写写法从进程环境块里删干净，
# 最后只按大写写法写回。没有重复时是纯 no-op，重复执行也保持幂等。
function Reset-ProxyEnvCase {
  $bases = @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY')
  # cmd /c set 按原样输出环境块，能区分大小写；$env: / GetEnvironmentVariables() 做不到
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
    if ($null -eq $upperVal -and $null -eq $lowerVal) { continue }   # 没设，跳过
    if ($null -ne $upperVal -and $null -eq $lowerVal) { continue }   # 只有大写，已经是规范形式
    if ($null -eq $upperVal -and $null -ne $lowerVal) {
      # 只有小写：改写成大写形式
      [Environment]::SetEnvironmentVariable($lower, $null, 'Process')
      [Environment]::SetEnvironmentVariable($base, $lowerVal, 'Process')
      $fixed++
      continue
    }
    # 两种大小写都有：保留大写形式的值，把小写那条删掉
    # （Win32 的 SetEnvironmentVariable 不区分大小写、一次只删一条，所以循环删；
    #   上限 4 次防止意外死循环）
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

$nodeExe = 'node'
try { $nodeExe = (Get-Command node -ErrorAction Stop).Source } catch {}

trap {
  Log ("异常中止: {0}" -f ($_ | Out-String).Trim())
  exit 1
}

Log '============================================================'
Log 'RESTART SCRIPT STARTED (detached launcher)'
Log ("script={0}" -f $MyInvocation.MyCommand.Path)
Log ("pwsh_pid={0} node={1}" -f $PID, $nodeExe)
Log ("reason: koishi.yml chatluna-dsh-tool:dsht01 groups = ['1040488785']")

# 先治环境变量撞名，再让任何 Start-Process 出场（幂等；日志里留下前后条数）
$proxyBefore = @(cmd /c set | Select-String -Pattern '(?i)^(https?_proxy|all_proxy|no_proxy)=').Count
$proxyFixed = Reset-ProxyEnvCase
$proxyAfter = @(cmd /c set | Select-String -Pattern '(?i)^(https?_proxy|all_proxy|no_proxy)=').Count
Log ("proxy env dedupe: before={0} fixed={1} after={2}" -f $proxyBefore, $proxyFixed, $proxyAfter)

Log '--- deliberate delay: 10 seconds (caller returns before this) ---'
Start-Sleep -Seconds 10

# ---------- 0. snapshot ----------
$targets = Get-KoishiNodeProcs
Log ("--- snapshot: koishi node processes found = {0} ---" -f $targets.Count)
foreach ($t in $targets) {
  Log ("  pid={0} ppid={1} cmd={2}" -f $t.ProcessId, $t.ParentProcessId, $t.CommandLine)
}
$sup = $targets | Where-Object { $_.CommandLine -match 'koishi[\\/]bin\.js' } | Select-Object -First 1
$wrk = $targets | Where-Object { $_.CommandLine -match 'koishi[\\/]lib[\\/]worker' } | Select-Object -First 1
Log ("supervisor_pid={0} worker_pid={1} port5140_pid={2}" -f `
    $(if ($sup) { $sup.ProcessId } else { 'none' }), `
    $(if ($wrk) { $wrk.ProcessId } else { 'none' }), `
    (Get-Listen5140))

# ---------- 1. graceful attempt (taskkill WITHOUT /F) ----------
foreach ($t in @($sup, $wrk)) {
  if (-not $t) { continue }
  Log ("graceful attempt: taskkill /PID {0} /T (no /F)" -f $t.ProcessId)
  $out = (taskkill /PID $t.ProcessId /T 2>&1 | Out-String).Trim()
  Log ("  exit_code={0} output={1}" -f $LASTEXITCODE, $out)
}
Start-Sleep -Seconds 2

# ---------- 2. fallback: Stop-Process (never taskkill /F) ----------
$alive = Get-KoishiNodeProcs
if ($alive.Count -gt 0) {
  Log 'graceful close did not work (console app); fallback to Stop-Process (NOT taskkill /F)'
  # 2a. supervisor first: keeps it from respawning the worker
  foreach ($t in @($sup)) {
    if (-not $t) { continue }
    if (Get-Process -Id $t.ProcessId -ErrorAction SilentlyContinue) {
      Stop-Process -Id $t.ProcessId -Force -ErrorAction SilentlyContinue
      Log ("  Stop-Process supervisor pid={0} -> stopped={1}" -f $t.ProcessId, (-not (Get-Process -Id $t.ProcessId -ErrorAction SilentlyContinue)))
    }
  }
  Start-Sleep -Seconds 1
  # 2b. descendants (e.g. mcp/websearch-server.cjs) of whatever remains
  foreach ($p in (Get-KoishiNodeProcs)) {
    foreach ($d in (Get-DescendantPids ([int]$p.ProcessId))) {
      Stop-Process -Id $d -Force -ErrorAction SilentlyContinue
      Log ("  Stop-Process descendant pid={0}" -f $d)
    }
  }
  # 2c. the port/db holder last
  foreach ($p in (Get-KoishiNodeProcs)) {
    $ppid = $p.ProcessId
    Stop-Process -Id $ppid -Force -ErrorAction SilentlyContinue
    Log ("  Stop-Process pid={0} -> stopped={1}" -f $ppid, (-not (Get-Process -Id $ppid -ErrorAction SilentlyContinue)))
  }
} else {
  Log 'graceful close worked; no fallback needed'
}

# ---------- 3. wait for port 5140 free ----------
$deadline = (Get-Date).AddSeconds(20)
$lp = Get-Listen5140
while ($lp -and (Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
  $lp = Get-Listen5140
}
if ($lp) {
  Log ("ABORT: port 5140 still LISTENING by pid={0}" -f $lp)
  exit 1
}
Log 'port 5140: no listener'

$left = Get-KoishiNodeProcs
if ($left.Count -gt 0) {
  Log ("ABORT: koishi node processes still alive: {0}" -f (($left | ForEach-Object { $_.ProcessId }) -join ','))
  exit 1
}
Log 'no koishi node process left'

# ---------- 4. sqlite integrity_check (rolls back hot journal) ----------
$journal = Join-Path $app 'data\koishi.db-journal'
Log ("before integrity_check: journal_present={0} db_present={1}" -f `
    (Test-Path -LiteralPath $journal), (Test-Path -LiteralPath (Join-Path $app 'data\koishi.db')))

$js = @'
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const p = 'data/koishi.db';
const had = fs.existsSync(p + '-journal');
const d = new DatabaseSync(p);
const ic = d.prepare('pragma integrity_check').all();
d.close();
console.log('RESULT ' + JSON.stringify({ had, integrity: ic[0] && ic[0].integrity_check, journalAfter: fs.existsSync(p + '-journal') }));
'@

Push-Location $app
try {
  $rr = (& $nodeExe -e $js 2>&1 | Out-String).Trim()
  $code = $LASTEXITCODE
} finally {
  Pop-Location
}
Log ("integrity_check exit_code={0}" -f $code)
Log ("integrity_check output: {0}" -f $rr)
if ($rr -notmatch '"integrity":"ok"') {
  Log 'ABORT: integrity_check did not return ok -> NOT starting koishi'
  exit 1
}
Log 'integrity_check ok -> journal rolled back (if any)'
if (Test-Path -LiteralPath $journal) { Log 'WARN: journal still present after check' } else { Log 'journal absent after check' }

# ---------- 5. start koishi ----------
$outLog = Join-Path $app 'restart-20261027-2156-koishi.out.log'
$errLog = Join-Path $app 'restart-20261027-2156-koishi.err.log'
Log ("starting: node node_modules/koishi/bin.js start  (cwd={0})" -f $app)
try {
  $proc = Start-Process -FilePath $nodeExe `
    -ArgumentList @('node_modules/koishi/bin.js', 'start') `
    -WorkingDirectory $app -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog -ErrorAction Stop
  Log ("started supervisor pid={0}" -f $proc.Id)
} catch {
  # 兜底：能走到这里说明环境字典那条路还是炸了（例如别的工具又塞进大小写重复项）。
  # 改用 .NET Process 直接拉起 cmd.exe，由 cmd 自己做文件重定向 —— 全程不构建
  # 任何环境变量字典，因此不会再被 HTTPS_PROXY / https_proxy 撞名影响。
  Log ("WARN: Start-Process failed: {0}" -f ($_ | Out-String).Trim())
  Log 'fallback: launch via cmd.exe redirection (no env dictionary)'
  $cmdLine = '"' + $nodeExe + '" node_modules/koishi/bin.js start >> "' + $outLog + '" 2>&1'
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $env:ComSpec
  $psi.Arguments = '/c "' + $cmdLine + '"'
  $psi.WorkingDirectory = $app
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $proc = [System.Diagnostics.Process]::Start($psi)
  Log ("fallback started cmd pid={0}" -f $proc.Id)
}
Log ("koishi stdout -> {0}" -f $outLog)
Log ("koishi stderr -> {0}" -f $errLog)

# ---------- 6. wait for 5140 LISTENING ----------
$deadline = (Get-Date).AddSeconds(90)
$ok = $false
while ((Get-Date) -lt $deadline) {
  $lp = Get-Listen5140
  if ($lp) { Log ("port 5140 LISTENING pid={0}" -f $lp); $ok = $true; break }
  Start-Sleep -Seconds 2
}
if (-not $ok) {
  Log 'ABORT: port 5140 not listening within 90s (see koishi out/err log)'
  exit 1
}

$tree = Get-KoishiNodeProcs
foreach ($t in $tree) { Log ("  alive pid={0} cmd={1}" -f $t.ProcessId, $t.CommandLine) }
Log 'RESTART SCRIPT DONE (ok)'
Log '============================================================'
exit 0
