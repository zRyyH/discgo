# DiscGo

Desktop app (Windows 10 20H1+ x64) in the style of Discord for a single community:
text channels, voice channels, screen sharing and webcam. Architecture, decisions
and phases are in [PLAN.md](PLAN.md); measurements in [docs/measurements.md](docs/measurements.md).

```
api/       Go: REST + WebSocket gateway, PostgreSQL, LiveKit tokens, S3 presign
engine/    Rust + GStreamer: screen capture sidecar (WGC -> D3D11 -> HW encoder -> WebRTC)
desktop/   Tauri 2 shell (Rust) + React/TypeScript/Tailwind UI in WebView2
deploy/    Docker Compose (dev and prod), nginx, LiveKit config
```

## Prerequisites (Windows)

| Tool | Version | Notes |
|---|---|---|
| Visual Studio Build Tools | 2022+ with "Desktop development with C++" | MSVC linker, `dumpbin`, CRT redist |
| Rust | stable (`rustup`) | |
| Go | 1.26+ | |
| Node.js | 24 LTS, with `pnpm` | |
| GStreamer | 1.26+ **MSVC x86_64**, full install (runtime + development) | sets `GSTREAMER_1_0_ROOT_MSVC_X86_64`; add its `bin` to `PATH` |
| Docker Desktop | | dev PostgreSQL and LiveKit |
| GNU make | optional | `mingw32-make` or `winget install ezwinports.make`; run from Git Bash |

GStreamer can be installed per user without admin rights:

```powershell
gstreamer-1.0-msvc-x86_64-<ver>.exe /VERYSILENT /CURRENTUSER /TYPE=full /DIR="$env:LOCALAPPDATA\Programs\gstreamer"
[Environment]::SetEnvironmentVariable('GSTREAMER_1_0_ROOT_MSVC_X86_64', "$env:LOCALAPPDATA\Programs\gstreamer\", 'User')
```

The Rust crates find GStreamer through its own `pkg-config.exe`; the Makefile sets
`PKG_CONFIG` and `PKG_CONFIG_PATH`. Without make:

```bash
export PKG_CONFIG="$GSTREAMER_1_0_ROOT_MSVC_X86_64/bin/pkg-config.exe"
export PKG_CONFIG_PATH="$GSTREAMER_1_0_ROOT_MSVC_X86_64/lib/pkgconfig"
```

## Running in dev

```bash
make infra-up        # PostgreSQL :5432 and LiveKit --dev :17880 (key devkey, secret in deploy/docker-compose.dev.yml)
make api             # API on :8080, applies migrations; GET /healthz
make engine          # build the engine; try it:
printf '{"cmd":"probe"}\n' | target/debug/discgo-engine.exe
make desktop         # Tauri window with the React UI (Vite on :1420)
```

Without make or Git Bash, [api.cmd](api.cmd) does the same as `make api`: run `api` in cmd
or `.\api` in PowerShell from the repository root.

API configuration is read from the environment; see [deploy/.env.example](deploy/.env.example).

## Engine runtime

`make gst-runtime` builds the engine in release mode and runs
[engine/gst-runtime/collect.ps1](engine/gst-runtime/collect.ps1), which copies the
plugins listed in [plugins.txt](engine/gst-runtime/plugins.txt) and their DLL
dependencies into `desktop/src-tauri/resources/gst/`. The resolved list is written
to `engine/gst-runtime/dlls.lock.txt`. To check the runtime is self-contained:

```powershell
.\engine\gst-runtime\collect.ps1 -StageDir $env:TEMP\discgo-engine-stage
```

and run `discgo-engine.exe` from that folder with `PATH` reduced to `C:\Windows\System32`.

## OneDrive

If the repository lives inside OneDrive, exclude `target/` and `node_modules/` from
sync (or move the repository): syncing them is slow and can corrupt builds.

## Engine measurements (phase 1 spike)

Quick look: `powershell -ExecutionPolicy Bypass -File engine\spike\demo.ps1` shares the primary
monitor P2P to a viewer window (`-Sfu` goes through the dev LiveKit). Ctrl+C stops it.

[engine/spike/](engine/spike/) holds the measurement harness: `serve.mjs` (viewer page,
LiveKit dev tokens, P2P signalling bridge to the engine), `viewer.html` (receiver with
a glass-to-glass barcode clock), `measure.ps1` (one run) and `suite.ps1` (the matrix).

```bash
make infra-up && make engine-release
node engine/spike/serve.mjs --engine target/release/discgo-engine.exe      # keep running
powershell -File engine/spike/suite.ps1 -Modes p2p,sfu -Presets 1080p60,1440p60 -Contents text,motion
```

The viewer opens fullscreen on the captured monitor for each run. Diagnostic switches
read by the engine: `DISCGO_ENGINE_LOG=debug|trace`, `DISCGO_ENGINE_CAPTURE_API=dxgi`,
`DISCGO_ENGINE_CC=disabled|homegrown`, `DISCGO_ENGINE_PACING_HEADROOM=<factor>`,
`DISCGO_ENGINE_KEEP_LATENCY=1`. The WebView2 checks run with
`pnpm tauri dev --config '{"build":{"devUrl":"http://localhost:1420/?spike=webview"}}'`
and report to the same harness.

## Releases (phase 8)

A tag `vX.Y.Z` (equal to `desktop/src-tauri/tauri.conf.json` `version`) runs
[.github/workflows/release.yml](.github/workflows/release.yml) on a Windows runner: it
installs GStreamer, builds the engine and its runtime, builds the NSIS installer
(per-user install, WebView2 bootstrapper), signs the update with minisign and uploads
`DiscGo_X.Y.Z_x64-setup.exe` + `latest.json` to `s3://$RELEASES_BUCKET/releases/`.
Installed apps check `latest.json` at start and every 6 h and offer "Atualizar e
reiniciar" in the titlebar.

Repository secrets: `TAURI_SIGNING_PRIVATE_KEY` (contents of the private key),
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (empty for the current key), `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`. Variables: `VITE_API_URL` (`https://api.DOMAIN`),
`RELEASES_BUCKET`, `AWS_REGION`. The updater endpoint is in `tauri.conf.json`
(`plugins.updater.endpoints`); change it if the bucket name differs.

The update key pair lives in `%USERPROFILE%\.tauri\discgo-updater.key(.pub)`; the public
key is in `tauri.conf.json`. Losing the private key means installed apps can no longer
be updated: back it up. A local release build: `make gst-runtime`, then
`TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/discgo-updater.key)" pnpm tauri build` in `desktop/`.

Code signing (Authenticode) is not set up: without it Windows SmartScreen warns on the
first installs, and Microsoft Defender's heuristics may quarantine an updated
`discgo.exe` (seen once in testing, see [docs/measurements.md](docs/measurements.md)).
With a certificate, set `bundle.windows.certificateThumbprint` (or `signCommand`) in
`tauri.conf.json` and import the certificate on the runner.
