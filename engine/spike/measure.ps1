<#
.SYNOPSIS
  One measurement run of the phase 1 spike: start a publisher, open the viewer
  fullscreen on the captured monitor, sample publisher CPU, print a summary.

.DESCRIPTION
  Expects engine/spike/serve.mjs to be running on -HarnessUrl and writing to
  -HarnessLog. The publisher is either an executable started here (-PublisherExe)
  or a process the harness already started (-SampleProcess only, e.g. the engine).

.EXAMPLE
  .\measure.ps1 -Label sfu-1080p60 -PublisherExe gst-launch-1.0.exe -PublisherArgs '...'
#>
param(
  [Parameter(Mandatory)] [string]$Label,
  [string]$PublisherExe,
  [string]$PublisherArgs,
  [string]$SampleProcess = 'gst-launch-1.0',
  [string]$Mode = 'sfu',
  [string]$Content = '',
  # JSON engine command posted to the harness after the viewer opens (engine-driven runs).
  [string]$StartCommand,
  [string]$HarnessUrl = 'http://127.0.0.1:8090',
  [string]$HarnessLog = "$env:TEMP\spike-harness.log",
  [int]$WarmupSec = 8,
  [int]$SampleSec = 15
)
$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profileDir = "$env:TEMP\edge-spike"

function Stop-SpikeEdge {
  Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
    Where-Object { $_.CommandLine -like "*edge-spike*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

Stop-SpikeEdge
$logStart = (Get-Content $HarnessLog -ErrorAction SilentlyContinue | Measure-Object -Line).Lines

$pub = $null
if ($PublisherExe) {
  $pub = Start-Process -FilePath $PublisherExe -ArgumentList $PublisherArgs -PassThru -WindowStyle Hidden `
    -RedirectStandardError "$env:TEMP\spike-$Label.err" -RedirectStandardOutput "$env:TEMP\spike-$Label.out"
  Start-Sleep -Seconds 2
}
Start-Process $edge -ArgumentList "--user-data-dir=$profileDir", '--no-first-run', '--autoplay-policy=no-user-gesture-required',
  '--start-fullscreen', "--app=$HarnessUrl/?mode=$Mode&content=$Content"
if ($StartCommand) {
  Start-Sleep -Seconds 2
  Invoke-RestMethod -Method Post -Uri "$HarnessUrl/engine" -Body $StartCommand | Out-Null
}
Start-Sleep -Seconds $WarmupSec

$proc = if ($pub) { Get-Process -Id $pub.Id } else { Get-Process $SampleProcess | Select-Object -First 1 }
$cpu0 = $proc.TotalProcessorTime; $t0 = Get-Date
Start-Sleep -Seconds $SampleSec
$proc.Refresh()
$cpu1 = $proc.TotalProcessorTime; $t1 = Get-Date
$wsMb = [math]::Round($proc.WorkingSet64 / 1MB, 1)
$cores = [Environment]::ProcessorCount
$cpuPct = 100 * ($cpu1 - $cpu0).TotalSeconds / ($t1 - $t0).TotalSeconds / $cores

Stop-SpikeEdge
if ($pub) { Stop-Process -Id $pub.Id -Force -ErrorAction SilentlyContinue }
if ($StartCommand) { Invoke-RestMethod -Method Post -Uri "$HarnessUrl/engine" -Body '{"cmd":"stop"}' | Out-Null }

$reports = Get-Content $HarnessLog | Select-Object -Skip $logStart |
  ForEach-Object { try { $_ | ConvertFrom-Json } catch {} } |
  Where-Object { $_.source -eq 'viewer' -and $_.fps -ne $null } | Select-Object -Last $SampleSec
$engineStats = Get-Content $HarnessLog | Select-Object -Skip $logStart |
  ForEach-Object { try { $_ | ConvertFrom-Json } catch {} } |
  Where-Object { $_.source -eq 'engine' -and $_.event -eq 'stats' } | Select-Object -Last $SampleSec

function Median($xs) { $s = @($xs | Where-Object { $_ -ne $null } | Sort-Object); if ($s.Count) { $s[[int]($s.Count / 2)] } else { $null } }
[pscustomobject]@{
  label            = $Label
  publisher_cpu    = '{0:N2} % of {1} logical CPUs ({2:N1} % of one core)' -f $cpuPct, $cores, ($cpuPct * $cores)
  publisher_ws_mb  = $wsMb
  res              = ($reports | Select-Object -Last 1).res
  decoder          = ($reports | Select-Object -Last 1).decoder
  fps_median       = Median ($reports | ForEach-Object fps)
  kbps_median      = Median ($reports | ForEach-Object kbps)
  jitter_buf_ms    = Median ($reports | ForEach-Object jitter_buffer_ms)
  g2g_p50_ms       = Median ($reports | ForEach-Object g2g_p50)
  g2g_p95_ms       = Median ($reports | ForEach-Object g2g_p95)
  g2g_samples      = ($reports | Measure-Object g2g_n -Sum).Sum
  g2g_bad          = ($reports | Measure-Object g2g_bad -Sum).Sum
  rtt_ms           = Median ($reports | ForEach-Object rtt_ms)
  dropped_last     = ($reports | Select-Object -Last 1).dropped
  engine_fps_enc   = Median ($engineStats | ForEach-Object fps_encoded)
  engine_enc_p50   = Median ($engineStats | ForEach-Object encode_ms_p50)
  reports          = @($reports).Count
} | Format-List
