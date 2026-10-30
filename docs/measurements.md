# Measurements

Numbers recorded at the end of each phase (PLAN.md section 10). Always state the
machine, build type and how the number was taken.

## Machines

| Id | CPU | GPU | RAM | OS |
|---|---|---|---|---|
| dev-1 | AMD Ryzen 5 5600GT (6C/12T) | NVIDIA GeForce GTX 1650 (driver 32.0.16.1088); Radeon iGPU not exposed to DXGI | 32 GB | Windows 11 Pro 10.0.26300 |
| ref | 2 physical cores, iGPU with HW encoder | | 8 GB | Windows 10/11 — **not measured yet** |

## Phase 0 — 2026-10-29 (dev-1)

| What | Result | How |
|---|---|---|
| Engine encoder probe | `nvd3d11h264enc` (HW, D3D11 input), `mfh264enc` (NVIDIA MFT, HW, D3D11 input), `x264enc` | `{"cmd":"probe"}` on stdin |
| Probe time, cold / cached | ~1.4 s for 4 candidates / 0.2 s process total | wall clock |
| GStreamer init (bundled runtime, cold registry) | 1.55 s | engine log timestamps |
| Bundled runtime size | 55.6 MB (41 core DLLs incl. MSVC CRT, 25 plugins); largest: `gstrswebrtc.dll` 16.2 MB, `libcrypto-3-x64.dll` 6.8 MB | `collect.ps1` |
| Isolated run | engine runs from `%TEMP%\discgo-engine-stage` with `PATH=System32` only, no GStreamer env; 0 references to the system install in `GST_DEBUG=GST_PLUGIN_LOADING:4` | `collect.ps1 -StageDir` |
| Desktop window, **debug build + Vite dev server** | shell + 6 WebView2 processes: 190 MB private, 387 MB working set (shared pages double-counted). Not comparable with the 120 MB budget, which is checked on a release build in phase 4 | Get-Process over the process tree |

Note: one probe run reported `nvd3d11h264enc: Failed to open session` right after the
NVIDIA MFT was tested. The probe now tests vendor SDK encoders first, retries a
failed hardware encoder once, and does not cache a probe that had failures.

## Phase 1 — 2026-10-29 (dev-1, engine spike)

Setup: one 3840×2160 @ 60 Hz monitor captured with WGC; the viewer
([engine/spike/viewer.html](../engine/spike/viewer.html)) runs fullscreen in Edge 156 on
the same machine. LiveKit 1.13.11 in Docker (`--dev`, ports 17880-17882). Release
engine, `nvd3d11h264enc` (GTX 1650), H.264 CBR at the preset bitrate, GCC on.
Content: `text` = scrolling code-like text; `motion` = 400 moving coloured blocks per frame.
Reproduce: `node engine/spike/serve.mjs --engine target/release/discgo-engine.exe` and
`engine/spike/suite.ps1`.

**Glass-to-glass method.** The page paints its clock as a 24-bit barcode in the top-left
corner on every `requestAnimationFrame`; each received frame is decoded with
`requestVideoFrameCallback` and compared with its `expectedDisplayTime`. The number
therefore includes the display pipeline on *both* ends (rAF → photon on the sender,
decode → photon on the receiver, ≈ 3-4 frames at 60 Hz) and is quantized to 16.7 ms.
It is not the 240 fps camera test of the plan; that one is still pending.

### Final engine (mode B, pacing headroom 2.5×, FEC off, shared D3D11 device)

| Run | Engine CPU (% of 12 threads) | Received | fps | kbit/s | Encode p50 | Jitter buffer | G2G p50 / p95 | Engine WS |
|---|---|---|---|---|---|---|---|---|
| P2P 1080p60 text | 0.68 % | 1920×1080 | 60 | 8 725 | 2.8 ms | 10.8 ms | 83 / 84 ms | 124 MB |
| P2P 1080p60 motion | 1.53 % | 1920×1080 | 60 | 8 448 | 2.8 ms | 9.7 ms | 83 / 84 ms | 122 MB |
| P2P 1440p60 text | 1.19 % | 2560×1440 | 60 | 12 281 | 3.7 ms | 14.7 ms | 83 / 100 ms | 137 MB |
| P2P 1440p60 motion | 1.21 % | 2560×1440 | 60 | 12 744 | 4.3 ms | 11.4 ms | 83 / 84 ms | 136 MB |
| SFU 1080p60 text | 1.43 % | 1920×1080 | 60.5 | 9 483 | 3.8 ms | 20.2 ms | 117 / 117 ms | 127 MB |
| SFU 1080p60 motion | 1.21 % | 1920×1080 | 60 | 8 233 | 2.9 ms | 10.3 ms | 83 / 84 ms | 127 MB |
| SFU 1440p60 text | 1.96 % | 2560×1440 | 60 | 13 893 | 3.8 ms | 27.2 ms | 100 / 100 ms | 142 MB |
| SFU 1440p60 motion | 1.66 % | 2560×1440 | 60 | 12 617 | 4.4 ms | 12.6 ms | 100 / 100 ms | 140 MB |

`started` reported `zero_copy: true` (every pad from the capture source to the encoder
in `memory:D3D11Memory`, encoder on the capture adapter) in all runs. On a static
screen WGC delivers 1-2 frames/s, so the engine idles at ~0 % while sharing.

### What was tried on the way

| Variant (P2P 1080p60) | Jitter buffer | G2G p50 | Notes |
|---|---|---|---|
| gst-launch, mode A (raw D3D11 into `webrtcsink`) | — | — | Fails: webrtcsink picks `nvh264enc` (CUDA, no D3D11 input); forcing `nvd3d11h264enc` by rank works but webrtcsink has no bitrate control for it ("Bitrate handling is not supported yet") |
| gst-launch, mode B, SFU | 8-33 ms | 83-116 ms | CPU 0.6-1.7 % |
| engine, FEC on (webrtcsink default) | 13.6 ms | 84 ms | 16 Mbit/s on the wire for an 8 Mbit/s encoder |
| engine, FEC off, GCC pacing 1.0× | 19-21 ms | 100-117 ms | `rtpgccbwe` paces at exactly its estimate |
| engine, FEC off, GCC pacing 2.5× | 10-13 ms | 100 ms | |
| engine, congestion control disabled | 10-15 ms | 100 ms | no pacing at all: no gain over 2.5× |
| engine, pipeline latency not forced to 0 | 10-13 ms | 83-100 ms | no measurable difference |

### Encoder bitrate under GCC

On a mostly static screen GCC's estimate collapses towards the acknowledged rate
(500 kbit/s floor in our config), so the first motion after a still period came out
blurry. The engine now ignores *decreases* while the stream is application-limited
(encoder output < 65 % of the applied bitrate).

### Engine memory across sessions

| Build | Per start/stop cycle |
|---|---|
| WGC, new D3D11 device per session | +95 MB private, +43 threads (never released) |
| DXGI capture | stable |
| `d3d11testsrc` instead of capture | stable |
| WGC + one shared D3D11 device per adapter (current) | threads/handles stable; +32 MB private (one 4K BGRA frame), working set stable |

The remaining +32 MB/cycle is inside `d3d11screencapturesrc` (WGC). Mitigation for
phase 6: keep the capture branch alive across P2P⇄SFU switches (swap only the sink)
and recycle the engine process when idle.

### WebView2 (Tauri window, Edge WebView2 156.0.4314.50)

| Risk | Result |
|---|---|
| Permission prompt for mic/camera | none: `getUserMedia` resolved in 29 ms via Tauri `on_permission_request` (app origin only). Camera path not exercised: dev-1 has no webcam |
| Throttling while minimized | window minimized 60 s (`IsIconic` = true): 50 ms interval max gap 67 ms, loopback call steady at 30 video fps / 50 audio packets/s, ICE connected throughout |
| Chromium version drift | recorded: Chromium 156 |

### Runtime

`collect.ps1`: 41 core DLLs (incl. MSVC CRT) + 25 plugins = 39.6 MB, plus the 7.3 MB
engine with `rswebrtc` linked statically (the DLL alone was 16.2 MB): 46.9 MB in total
(target ≤ 60 MB). The staged engine ran probe, SFU capture with system audio and a
P2P session with `PATH=C:\Windows\System32` only. A truly clean machine (no VC++
redistributable, no GStreamer ever installed) was **not** tested: Windows Sandbox is
not enabled on dev-1.

## Phases 2-4 — 2026-10-29 (dev-1)

| What | Result | How |
|---|---|---|
| `POST /messages` → `message_create` on two gateway clients | 3.8 ms (budget 100 ms) | `go test ./internal/app -run TestMessagesAndEvents -v` |
| Third participant joins → `voice_session` sfu on all three clients | 0.5 ms server side | `TestVoiceModes` |
| Back to p2p after the third leaves | after `P2P_SWITCH_DELAY` (300 ms in the test, 10 s by default), never before | `TestVoiceModes` |
| Idle app, release build, 60 s after start | 86.0 MB private working set over 7 processes (shell 3.6 MB + WebView2), 0.05 % CPU of 12 threads (≈ 0.6 % of one core) | `docs/measure-idle.ps1 -SettleSec 60 -SampleSec 60` |
| Idle app, first 50 s after start | 113.5 MB, 0.72 % CPU (startup work still settling) | same, `-SettleSec 20 -SampleSec 30` |
| Steady idle CPU by process | GPU process 0.55 %, renderer 0.16 %, everything else 0 % (of one core) | per-process sample |
| Scroll 2,000 messages top↔bottom, 80 px per frame (dev build, React dev mode) | run 1: 3,920 frames, p95 16.8 ms, 2 missed frames (one 250 ms hitch, a single long animation frame of 281 ms); run 2: 3,931 frames, max 16.9 ms, 0 missed, 0 long animation frames | `?spike=scroll&channel=<id>` (`desktop/src/spike/scrollCheck.ts`) |
| Load 2,000 messages page by page (40 × 50) | 4.2-4.5 s | same probe |
| Session survives restart | yes (token from the Credential Manager, no login screen) | restart of the dev app |

Not covered: Google login with real accounts (needs OAuth client credentials), and the
side-by-side visual review with Discord.

## Phase 5 — 2026-10-29 (dev-1, voice and webcam)

Participants: the Tauri app (real microphone) and/or the dev UI in Edge app windows
with Chromium's fake microphone/camera (`desktop/scripts/participant.ps1`), all on
dev-1 against the local API and LiveKit. Numbers from the `?report=1` call reports.

| What | Result |
|---|---|
| 2 people → P2P | connected 585-641 ms after `voice_session`; host/UDP pair; RTT ≈ 0 ms; voice jitter buffer 31-33 ms; speaking detected on both sides |
| Third joins → everyone in SFU | 349 / 352 / 794 ms from `voice_session` to connected (budget 2 s); every client receives the other two mics |
| Mute and camera across the switch | dev1 muted with camera on, dev3 camera on in P2P → after the switch to SFU: same mute, both cameras still published and received by the newcomer |
| Third leaves (window closed) → back to P2P | 21 s (10 s disconnect grace + 10 s hysteresis), P2P connected in 100 ms |
| P2P cannot connect (`?force_p2p_fail=1`: relay-only ICE, no TURN, as a client without UDP) | P2P timeout at 8 s → `p2p_failed` → both in SFU 10 s after joining, connected in 161-181 ms |
| App minimized 5 min in a P2P call | 300/300 one-second reports, connected all the time, remote track present all the time, jitter buffer avg 30 ms / max 31 ms |
| Voice call, Tauri app, P2P, real mic (dev build, Vite + React dev mode) | 0.43 % CPU of 12 threads (5.2 % of one core), 164 MB private working set (budget 3 % / 180 MB) |
| Voice bitrate on the wire | 80-155 kbit/s per direction: Opus 64 kbit/s with RED (redundant copy) plus headers |

Mouth-to-ear latency was not measured directly. On localhost it is about one 20 ms
Opus frame + the ~30 ms jitter buffer + capture/playout device buffers; a real check
needs two machines and a loopback recording.

## Phase 6 — 2026-10-29 (dev-1, screen sharing in the app)

The Tauri app (dev1) shares the 4K primary monitor through the engine sidecar at
1080p60; viewers are dev UI windows in Edge (`?share=1`, `?report=1`).

| What | Result |
|---|---|
| P2P share, one viewer | engine `nvd3d11h264enc`, `zero_copy=true`, 58.8 fps encoded, ~10 Mbit/s (1 s window); viewer receives the screen over its own receive-only RTCPeerConnection |
| SFU share, two viewers | both viewers receive `dev1:screen` through LiveKit (`{user_id}#screen` participant) |
| Two sharers at once in the SFU | second engine publishing as `dev2#screen` (720p30): every other participant receives both screens |
| Transport switch while sharing | P2P → SFU (third person joins): share running again 1,450 ms after the new session connected; SFU → P2P: 134 ms |
| Engine killed while sharing | app restarts the sidecar and the share: 903 ms from restart to `started`, ≈ 2.4 s wall clock from the kill |
| Source picker thumbnails (GDI) | 1 monitor + 3 windows, 21-35 KB PNG each, no WGC captures opened |
| Zero-copy on AMD and Intel | not tested (no such GPU on dev-1) |
| `getDisplayMedia` fallback (720p30, SFU only) | implemented, not exercised |

Fixed on the way: the server no longer blocks a pair for P2P when `p2p_failed` comes
from a peer whose gateway connection already dropped (app closed or crashed); the
SFU session no longer subscribes to its own `#screen` participant.

## Phase 8 — 2026-10-29 (dev-1, installer and updates)

Local release builds (`make gst-runtime`, `pnpm tauri build` with the updater key);
the CI workflow was checked with actionlint, not run (no GitHub remote yet).

| What | Result |
|---|---|
| NSIS installer, per-user, WebView2 bootstrapper | 15.4 MiB (16,108,075 bytes; budget 90 MB) |
| Installed layout | 55.3 MB: `discgo.exe`, `discgo-engine.exe`, 41 GStreamer/CRT DLLs at the install root, 25 plugins in `resources/gst/plugins` |
| Installed engine with `PATH=C:\Windows\System32` | `probe` lists the encoders; `start` 1080p60 → `nvd3d11h264enc`, `zero_copy=true` |
| NVENC sessions across start/stop | one engine: 10 start/stop cycles + 1 start, all `nvd3d11h264enc`; a second engine started meanwhile also got NVENC (no leaked sessions) |
| Update check (installed 0.1.0, local `latest.json` for 0.1.1) | "Atualizar e reiniciar" shows in the titlebar right after start |
| Update install | download + minisign check passed and the 0.1.1 installer ran in passive mode; Microsoft Defender then quarantined the new `discgo.exe` as `Trojan:Win32/Bearfoos.A!ml` and removed its shortcuts and uninstall key |
| Same files, on-demand Defender scan | `discgo.exe` 0.1.1 and its installer: no threats found |

The Defender hit is a machine-learning heuristic on an unsigned binary installed into
`%TEMP%` by an installer that the app downloaded over plain HTTP from localhost (the
test setup); a static scan of the same files is clean. It is still a real risk for
unsigned releases: Authenticode signing is the mitigation, and a false positive can
be reported at https://www.microsoft.com/wdsi/filesubmission. Still to do on real
infrastructure: a clean Windows VM (install, login, voice, screen share) and an update
from the S3 bucket over HTTPS.

## Phase 9A — 2026-10-29 (dev-1, forced update during a call)

Setup: local release builds 0.1.0 (installed) and 0.1.1 with the updater endpoint pointed
at a local server (`--config` override, see README), the API with
`RELEASES_URL=http://127.0.0.1:18090/latest.json RELEASES_POLL=5s`, the installed app in
a P2P call in "Sala" with a browser participant (`participant.ps1 -Report`). Then
`latest.json` was switched from 0.1.0 to 0.1.1, with no input on the app.

| Step | Time |
|---|---|
| `latest.json` switched to 0.1.1 | 21:47:21.8 |
| API sees it (5 s poll) and sends `app_update`; the app checks and starts the download | 21:47:26.0 |
| Download (15.4 MiB, localhost) + 3 s countdown; the app stops the engine and exits | 21:47:32.3 (gateway closed, 1001) |
| Silent installer (`/S /UPDATE /R`) done, 0.1.1 started | 21:47:35 |
| 0.1.1 identifies (`version: "0.1.1"`) and is back in the call | 21:47:36.1 |

Publish → back in the call: 14.3 s, of which 4.2 s waiting for the poll (60 s in
production). The app was away from the gateway for 3.7 s, inside the 10 s voice grace,
so the server kept its place and the same P2P session id; the participant's report never
left `p2p/connected` and the pair reconnected (new `host ↔ host` candidate pair). The
saved resume state was read and cleared on start. No Defender detection this time
(install root `%LOCALAPPDATA%\DiscGo`, not `%TEMP%`). Not covered here: an update that
takes longer than the 10 s grace (the app then rejoins from the saved resume state), two
installed apps on two machines, and the S3/HTTPS path.

Found while testing 9A: when the *polite* peer of a P2P call restarted inside the 10 s
grace (a browser participant reload here, an update restart in practice), the server
handed it the old session, the impolite peer kept its dead peer connection, P2P timed
out and `p2p_failed` moved the pair to SFU for the block TTL (1 h). Fix: `voice_join`
carries the `session_id` the client still has media for; a rejoin without it (app just
started) gets a new P2P session for both peers. After the fix, same machine:

| Restart | Result |
|---|---|
| Polite peer (browser participant closed and reopened in 2 s) | new session, P2P connected 380 ms after it, no `p2p_failed` |
| Impolite peer (installed app, forced update 0.1.2 → 0.1.3) | new session, P2P connected 526 ms after it; app away from the gateway 3.8 s |

## Phase 9D — 2026-10-29 (dev-1, tray)

Installed local build 0.1.3, delivered by the forced update itself, in a P2P call with a
browser participant. The window's close was sent as `WM_CLOSE` (what the X and Alt+F4 do).

| Check | Result |
|---|---|
| `WM_CLOSE` on the window | window hidden, process alive, tray icon registered (`HKCU\Control Panel\NotifyIconSettings`, tooltip "DiscGo"); Windows 11 shows it under "^" until the user pins it |
| 10 min hidden in the call (22:04:40 → 22:14:54, sampled every 30 s) | same P2P session the whole time, app's gateway never dropped, RTT from the app's RTCP kept updating (0–5 ms), participant kept receiving the app's track |
| Start the exe again while hidden | the running instance shows its window (single instance), no second process |
| Start with Windows | `HKCU\...\Run\DiscGo = "...\discgo.exe --autostart"` written on first start (setting on by default) |

Not checked here (needs a person): the icon turning green while *you* speak (the app
used this machine's real microphone), the tray menu's Silenciar / Ensurdecer / Sair, and a
real log-on start with `--autostart` staying in the tray.

## Phase 9B — 2026-10-29 (dev-1, installer)

| Check | Result |
|---|---|
| Double-click install (0.1.4 over 0.1.3, 0.1.5 over itself) | one dark page (mark, "Instalando o DiscGo…", accent bar), no questions, about 3 s; the running app is closed and the new one opens by itself |
| Forced update through the new template (silent, 0.1.4 → 0.1.5) | works as before: away from the gateway 4.4 s |
| Installer size | 15.4 MiB (16,171,144 bytes; budget 90 MB) |

The progress bar is the Windows control with its visual style removed so it takes the
accent; the SmartScreen warning on first run stays until the code is signed.
