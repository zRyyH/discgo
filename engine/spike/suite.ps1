<#
.SYNOPSIS
  Runs the phase 1 engine measurement matrix through measure.ps1 and prints one
  line per run. Needs serve.mjs running with --engine.

.EXAMPLE
  node engine/spike/serve.mjs --engine target/release/discgo-engine.exe   # other terminal
  .\engine\spike\suite.ps1 -Modes p2p,sfu -Presets 1080p60,1440p60 -Contents text,motion
#>
param(
  [string[]]$Modes = @('p2p', 'sfu'),
  [string[]]$Presets = @('1080p60', '1440p60'),
  [string[]]$Contents = @('text', 'motion'),
  [string]$MonitorId,
  [string]$HarnessUrl = 'http://127.0.0.1:8090',
  [string]$Tag = ''
)
$ErrorActionPreference = 'Stop'
if (-not $MonitorId) {
  # The primary monitor's HMONITOR, as the engine reports it.
  $exe = Join-Path $PSScriptRoot '..\..\target\release\discgo-engine.exe'
  $ErrorActionPreference = 'Continue' # the engine logs on stderr
  $out = '{"cmd":"list_sources"}' | & $exe 2>$null | Out-String
  $MonitorId = ($out | ConvertFrom-Json).monitors |
    Where-Object primary | Select-Object -First 1 -ExpandProperty id
  $ErrorActionPreference = 'Stop'
}
$results = foreach ($mode in $Modes) {
  foreach ($preset in $Presets) {
    foreach ($content in $Contents) {
      $target = if ($mode -eq 'p2p') {
        @{ kind = 'p2p'; session_id = "p2p-$(Get-Random)" }
      } else {
        $t = Invoke-RestMethod "$HarnessUrl/token?identity=screen&room=spike"
        @{ kind = 'livekit'; url = $t.url; token = $t.token }
      }
      $cmd = @{ cmd = 'start'; target = $target; source = @{ kind = 'monitor'; id = $MonitorId };
        preset = $preset; content_mode = $content } | ConvertTo-Json -Compress -Depth 4
      $label = "$mode-$preset-$content$Tag"
      $r = & (Join-Path $PSScriptRoot 'measure.ps1') -Label $label -Mode $mode -Content $content `
        -SampleProcess discgo-engine -StartCommand $cmd -HarnessUrl $HarnessUrl | Out-String
      $get = { param($k) if ($r -match "(?m)^$k[ \t]*:[ \t]*(.*?)\r?$") { $Matches[1].Trim() } }
      [pscustomobject]@{
        run = $label; cpu = (& $get 'publisher_cpu') -replace ' of .*', ''; res = & $get 'res'
        fps = & $get 'fps_median'; kbps = & $get 'kbps_median'; enc_ms = & $get 'engine_enc_p50'
        jb_ms = & $get 'jitter_buf_ms'; g2g_p50 = & $get 'g2g_p50_ms'; g2g_p95 = & $get 'g2g_p95_ms'
        ws_mb = & $get 'publisher_ws_mb'
      }
      Start-Sleep -Seconds 2
    }
  }
}
$results | Format-Table -AutoSize
