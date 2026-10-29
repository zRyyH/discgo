<#
.SYNOPSIS
  Idle budget check (PLAN 1.3): memory and CPU of discgo.exe plus its WebView2
  (and engine) child processes.

.EXAMPLE
  .\docs\measure-idle.ps1 -Exe target\release\discgo.exe -SettleSec 20 -SampleSec 30
#>
param(
  [string]$Exe = 'target\release\discgo.exe',
  [int]$SettleSec = 20,
  [int]$SampleSec = 30,
  [switch]$KeepRunning
)
$ErrorActionPreference = 'Stop'
Get-Process discgo -ErrorAction SilentlyContinue | Stop-Process -Force
$root = Start-Process -FilePath (Resolve-Path $Exe) -PassThru
Start-Sleep -Seconds $SettleSec

function Tree([int]$id) {
  $all = Get-CimInstance Win32_Process
  $ids = [System.Collections.Generic.List[int]]::new(); $ids.Add($id)
  for ($i = 0; $i -lt $ids.Count; $i++) {
    $all | Where-Object ParentProcessId -eq $ids[$i] | ForEach-Object { $ids.Add([int]$_.ProcessId) }
  }
  $ids | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }
}

$procs = @(Tree $root.Id)
$cpu0 = 0; foreach ($p in $procs) { $cpu0 += $p.TotalProcessorTime.TotalSeconds }
$t0 = Get-Date
Start-Sleep -Seconds $SampleSec
$cpu1 = 0; foreach ($p in $procs) { $p.Refresh(); $cpu1 += $p.TotalProcessorTime.TotalSeconds }
$elapsed = ((Get-Date) - $t0).TotalSeconds
$cores = [Environment]::ProcessorCount

# Private working set is what Task Manager shows as "Memory"; plain working set double-counts shared pages.
$rows = foreach ($p in $procs) {
  $priv = (Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Filter "IDProcess=$($p.Id)").WorkingSetPrivate
  [pscustomobject]@{ Id = $p.Id; Name = $p.ProcessName; PrivateWS_MB = [math]::Round($priv / 1MB, 1); WS_MB = [math]::Round($p.WorkingSet64 / 1MB, 1); Commit_MB = [math]::Round($p.PrivateMemorySize64 / 1MB, 1) }
}
$rows | Format-Table -AutoSize | Out-String
'processes: {0}' -f $rows.Count
'private working set total: {0:N1} MB   (working set total {1:N1} MB, commit {2:N1} MB)' -f ($rows | Measure-Object PrivateWS_MB -Sum).Sum, ($rows | Measure-Object WS_MB -Sum).Sum, ($rows | Measure-Object Commit_MB -Sum).Sum
'cpu over {0:N0} s: {1:N2} % of {2} logical CPUs' -f $elapsed, (100 * ($cpu1 - $cpu0) / $elapsed / $cores), $cores
if (-not $KeepRunning) { Stop-Process -Id $root.Id -Force }
