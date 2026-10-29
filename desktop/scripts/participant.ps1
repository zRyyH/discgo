<#
.SYNOPSIS
  Opens the dev UI in an Edge app window as another user, with Chromium's fake
  microphone and camera, to test calls with several people on one machine.

.DESCRIPTION
  Needs `pnpm dev` (Vite on :1420) and the API with AUTH_DEV=true. With -Report the
  window posts its call state every second to engine/spike/serve.mjs (:8090).

.EXAMPLE
  .\desktop\scripts\participant.ps1 -Email dev2@local -Join <voice channel id> -Report
  .\desktop\scripts\participant.ps1 -Email dev3@local -Join <id> -Report -ForceP2PFail
  .\desktop\scripts\participant.ps1 -Close   # closes every participant window
#>
param(
  [string]$Email,
  [string]$Join,
  [switch]$Report,
  [switch]$ForceP2PFail,
  [switch]$Cam,
  [switch]$Mute,
  [switch]$Close,
  [int]$X = 40,
  [int]$Y = 40
)
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
if ($Close) {
  Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*discgo-participant-*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  return
}
if (-not $Email) { throw '-Email is required' }
$q = @("dev_email=$Email")
if ($Join) { $q += "autojoin=$Join" }
if ($Report) { $q += 'report=1' }
if ($ForceP2PFail) { $q += 'force_p2p_fail=1' }
if ($Cam) { $q += 'cam=1' }
if ($Mute) { $q += 'mute=1' }
$url = 'http://localhost:1420/?' + ($q -join '&')
$profile = Join-Path $env:TEMP ('discgo-participant-' + ($Email -replace '[^a-zA-Z0-9]', '_'))
Start-Process $edge -ArgumentList "--user-data-dir=$profile", '--no-first-run', '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', "--window-position=$X,$Y",
  '--window-size=960,640', "--app=$url"
