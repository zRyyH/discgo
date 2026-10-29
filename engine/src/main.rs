//! discgo-engine: native screen-capture sidecar. Reads commands from stdin and
//! writes events to stdout, one JSON object per line (see protocol.rs).

mod adapters;
mod encoder;
mod logger;
mod protocol;
mod runtime;

use std::io::{BufRead, Write};

use gstreamer as gst;

use protocol::{Command, Event};

fn main() {
    logger::init();
    match runtime::configure() {
        runtime::Runtime::Bundled(dir) => {
            log::info!("gstreamer runtime: bundled, plugins at {}", dir.display())
        }
        runtime::Runtime::System => log::info!("gstreamer runtime: system"),
    }
    if let Err(e) = gst::init() {
        emit(&Event::Error {
            code: "gst_init".into(),
            message: e.to_string(),
            fatal: true,
        });
        std::process::exit(1);
    }
    log::info!("{} initialized", gst::version_string());

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
        match cmd {
            Command::Probe { force } => {
                let result = encoder::probe(force);
                emit(&Event::Ready {
                    gst_version: gst::version_string().to_string(),
                    encoders: result.encoders,
                    warnings: result.warnings,
                });
            }
            Command::Shutdown => break,
        }
    }
    log::info!("shutting down");
}

fn emit(event: &Event) {
    let mut out = std::io::stdout().lock();
    let _ = serde_json::to_writer(&mut out, event);
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}
