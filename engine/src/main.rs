//! discgo-engine: native screen-capture sidecar. Reads commands from stdin and
//! writes events to stdout, one JSON object per line (see protocol.rs).

mod adapters;
mod encoder;
mod logger;
mod pipeline;
mod process;
mod protocol;
mod runtime;
mod signaller_gateway;
mod sources;
mod stats;

use std::io::{BufRead, Write};

use gstreamer as gst;
use windows::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext,
};

use protocol::{Command, EncoderInfo, Event};

fn main() {
    logger::init();
    // Physical pixels everywhere (monitor rects, window bounds).
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    match runtime::configure() {
        runtime::Runtime::Bundled(dir) => {
            log::info!("gstreamer runtime: bundled, plugins at {}", dir.display())
        }
        runtime::Runtime::System => log::info!("gstreamer runtime: system"),
    }
    if let Err(e) = init_gstreamer() {
        emit(&Event::Error {
            code: "gst_init".into(),
            message: format!("{e:#}"),
            fatal: true,
        });
        std::process::exit(1);
    }
    log::info!("{} initialized", gst::version_string());

    let mut encoders: Option<Vec<EncoderInfo>> = None;
    let mut session: Option<pipeline::Session> = None;

    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let cmd: Command = match serde_json::from_str(line) {
            Ok(c) => c,
            Err(e) => {
                emit(&Event::Error {
                    code: "bad_command".into(),
                    message: e.to_string(),
                    fatal: false,
                });
                continue;
            }
        };
        if session.as_ref().is_some_and(|s| !s.is_alive()) {
            session = None; // died on a pipeline error, already reported
        }
        match cmd {
            Command::Probe { force } => {
                let result = encoder::probe(force);
                encoders = Some(result.encoders.clone());
                emit(&Event::Ready {
                    gst_version: gst::version_string().to_string(),
                    encoders: result.encoders,
                    warnings: result.warnings,
                });
            }
            Command::ListSources => emit(&Event::Sources {
                monitors: sources::monitors(),
                windows: sources::windows(),
            }),
            Command::Start(params) => {
                if session.take().is_some() {
                    emit(&Event::Stopped);
                }
                let list = encoders.get_or_insert_with(|| encoder::probe(false).encoders);
                match pipeline::Session::start(&params, list) {
                    Ok(s) => session = Some(s),
                    Err(e) => emit(&Event::Error {
                        code: "start_failed".into(),
                        message: format!("{e:#}"),
                        fatal: false,
                    }),
                }
            }
            Command::Update {
                preset,
                content_mode,
            } => match &session {
                Some(s) => s.update(preset, content_mode),
                None => not_started(),
            },
            Command::Sdp {
                session_id,
                kind,
                sdp,
            } => match &session {
                Some(s) => {
                    if let Err(e) = s.handle_sdp(&session_id, kind, &sdp) {
                        emit(&Event::Error {
                            code: "bad_sdp".into(),
                            message: format!("{e:#}"),
                            fatal: false,
                        });
                    }
                }
                None => not_started(),
            },
            Command::Ice {
                session_id,
                candidate,
                sdp_mid,
                sdp_m_line_index,
            } => match &session {
                Some(s) => {
                    if let Err(e) = s.handle_ice(&session_id, &candidate, sdp_m_line_index, sdp_mid)
                    {
                        emit(&Event::Error {
                            code: "bad_ice".into(),
                            message: format!("{e:#}"),
                            fatal: false,
                        });
                    }
                }
                None => not_started(),
            },
            Command::Stop => {
                if session.take().is_some() {
                    emit(&Event::Stopped);
                }
            }
            Command::Shutdown => break,
        }
    }
    drop(session);
    log::info!("shutting down");
}

/// Initializes GStreamer and registers the statically linked WebRTC plugin
/// (PLAN 6.5), replacing any `rswebrtc` DLL the registry found on disk.
fn init_gstreamer() -> anyhow::Result<()> {
    gst::init()?;
    let registry = gst::Registry::get();
    if let Some(plugin) = registry.find_plugin("rswebrtc") {
        log::info!("ignoring rswebrtc plugin at {:?}", plugin.filename());
        registry.remove_plugin(&plugin);
    }
    gstrswebrtc::plugin_register_static()?;
    Ok(())
}

fn not_started() {
    emit(&Event::Error {
        code: "not_started".into(),
        message: "no capture is running".into(),
        fatal: false,
    });
}

/// Writes one event line to stdout. Called from any thread.
pub fn emit(event: &Event) {
    let mut out = std::io::stdout().lock();
    let _ = serde_json::to_writer(&mut out, event);
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}
