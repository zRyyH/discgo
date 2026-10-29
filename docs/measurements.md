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
