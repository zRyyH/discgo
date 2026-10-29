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
