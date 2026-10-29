<#
.SYNOPSIS
  Live demo of the capture engine: shares the primary monitor to a viewer window.

.DESCRIPTION
  Starts the spike harness with the release engine, opens the viewer in an Edge app
  window and starts sharing. P2P by default (no server needed); -Sfu goes through the
  dev LiveKit (run `make infra-up` first). Engine stats are printed once a second.
  Press Ctrl+C to stop (or pass -Seconds). Press F11 in the viewer for fullscreen: the
  glass-to-glass number is only valid fullscreen on the captured monitor.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File engine\spike\demo.ps1
  powershell -ExecutionPolicy Bypass -File engine\spike\demo.ps1 -Sfu -Preset 1440p60 -Content motion
#>
param(
  [switch]$Sfu,
  [ValidateSet('720p30', '1080p30', '1080p60', '1440p60', 'native60')] [string]$Preset = '1080p60',
  [ValidateSet('text', 'motion')] [string]$Content = 'text',
  [int]$Seconds = 0,
  [int]$Port = 8090
)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..\..')
$engine = Join-Path $root 'target\release\discgo-engine.exe'
if (-not (Test-Path $engine)) { throw "engine not built: run 'cargo build --release -p discgo-engine' (see README)" }
$gst = $env:GSTREAMER_1_0_ROOT_MSVC_X86_64
if (-not $gst) { $gst = [Environment]::GetEnvironmentVariable('GSTREAMER_1_0_ROOT_MSVC_X86_64', 'User') }
if ($gst) { $env:Path = "$(Join-Path $gst 'bin');$env:Path" }

# Primary monitor id, straight from the engine.
$psi = New-Object System.Diagnostics.ProcessStartInfo $engine
$psi.UseShellExecute = $false; $psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
$p = [System.Diagnostics.Process]::Start($psi)
$null = $p.StandardError.ReadToEndAsync()
$p.StandardInput.WriteLine('{"cmd":"list_sources"}'); $p.StandardInput.Close()
$monitor = ($p.StandardOutput.ReadToEnd() | ConvertFrom-Json).monitors | Where-Object primary | Select-Object -First 1
$p.WaitForExit()
"capturing $($monitor.name) $($monitor.width)x$($monitor.height) -> $Preset ($Content), $(if ($Sfu) { 'SFU via LiveKit' } else { 'P2P' })"

$log = Join-Path $env:TEMP 'discgo-demo.log'
$harness = Start-Process node -ArgumentList (Join-Path $root 'engine\spike\serve.mjs'), '--port', $Port, '--engine', $engine `
  -PassThru -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError "$log.err"
$edge = $null
try {
  $url = "http://127.0.0.1:$Port"
  for ($i = 0; $i -lt 50; $i++) { try { Invoke-WebRequest "$url/token" -UseBasicParsing | Out-Null; break } catch { Start-Sleep -Milliseconds 200 } }
  $mode = if ($Sfu) { 'sfu' } else { 'p2p' }
  $edgeExe = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
  $edge = Start-Process $edgeExe -PassThru -ArgumentList "--user-data-dir=$env:TEMP\edge-discgo-demo", '--no-first-run',
    '--autoplay-policy=no-user-gesture-required', '--window-size=1280,760', "--app=$url/?mode=$mode&content=$Content"
  Start-Sleep -Seconds 2
  $target = if ($Sfu) {
    $t = Invoke-RestMethod "$url/token?identity=screen&room=spike"
    @{ kind = 'livekit'; url = $t.url; token = $t.token }
  } else { @{ kind = 'p2p'; session_id = "demo-$(Get-Random)" } }
  $start = @{ cmd = 'start'; target = $target; source = @{ kind = 'monitor'; id = $monitor.id }; preset = $Preset; content_mode = $Content }
  Invoke-RestMethod -Method Post "$url/engine" -Body ($start | ConvertTo-Json -Compress -Depth 4) | Out-Null

  $seen = 0; $deadline = if ($Seconds) { (Get-Date).AddSeconds($Seconds) } else { [datetime]::MaxValue }
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 1
    $lines = @(Get-Content $log -ErrorAction SilentlyContinue)
    $new = if ($lines.Count -gt $seen) { $lines[$seen..($lines.Count - 1)] } else { @() }
    foreach ($l in $new) {
      $e = try { $l | ConvertFrom-Json } catch { $null }
      if (-not $e -or $e.source -ne 'engine') { continue }
      switch ($e.event) {
        'started' { "started: $($e.encoder) $($e.width)x$($e.height)@$($e.fps) zero_copy=$($e.zero_copy)" }
        'stats' { '{0,5:N1} fps  {1,6} kbit/s (target {2})  encode {3:N1} ms  rtt {4}' -f $e.fps_encoded, $e.bitrate_kbps, $e.target_kbps, $e.encode_ms_p50, $e.rtt_ms }
        'error' { "engine error: $($e.code) $($e.message)" }
      }
    }
    if ($lines.Count -gt $seen) { $seen = $lines.Count }
  }
} finally {
  try { Invoke-RestMethod -Method Post "http://127.0.0.1:$Port/engine" -Body '{"cmd":"shutdown"}' | Out-Null } catch {}
  Start-Sleep -Milliseconds 500
  Stop-Process -Id $harness.Id -Force -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*edge-discgo-demo*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  'stopped'
}
