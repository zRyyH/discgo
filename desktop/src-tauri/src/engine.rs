//! The capture engine sidecar (PLAN 7.2): one JSON line per message on its
//! stdin/stdout. Each stdout line is forwarded to the UI as `engine://event`;
//! `engine://exit` tells the UI the process died (it restarts it if sharing).

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};

#[derive(Default)]
pub struct EngineState(Mutex<Option<CommandChild>>);

#[tauri::command]
pub fn engine_start<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let state = app.state::<EngineState>();
    let mut slot = state.0.lock().unwrap();
    if slot.is_some() {
        return Ok(());
    }
    let (mut rx, child) = app
        .shell()
        .sidecar("discgo-engine")
        .map_err(|e| e.to_string())?
        .spawn()
        .map_err(|e| e.to_string())?;
    let pid = child.pid();
    log::info!("engine started (pid {pid})");
    *slot = Some(child);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            match ev {
                CommandEvent::Stdout(line) => {
                    let line = String::from_utf8_lossy(&line).trim().to_owned();
                    if !line.is_empty() {
                        let _ = handle.emit("engine://event", line);
                    }
                }
                CommandEvent::Stderr(line) => {
                    log::debug!("engine: {}", String::from_utf8_lossy(&line).trim())
                }
                CommandEvent::Terminated(status) => {
                    log::info!("engine {pid} exited: {:?}", status.code);
                    let state = handle.state::<EngineState>();
                    let mut slot = state.0.lock().unwrap();
                    if slot.as_ref().is_some_and(|c| c.pid() == pid) {
                        *slot = None;
                    }
                    let _ = handle.emit("engine://exit", status.code);
                }
                _ => {}
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn engine_send<R: Runtime>(app: AppHandle<R>, line: String) -> Result<(), String> {
    let state = app.state::<EngineState>();
    let mut slot = state.0.lock().unwrap();
    let child = slot.as_mut().ok_or("engine is not running")?;
    let mut bytes = line.into_bytes();
    bytes.push(b'\n');
    child.write(&bytes).map_err(|e| e.to_string())
}

/// Asks the engine to exit; it tears its pipeline down on `shutdown`. Returns
/// whether it was running (`engine://exit` follows when it was).
#[tauri::command]
pub fn engine_stop<R: Runtime>(app: AppHandle<R>) -> bool {
    let state = app.state::<EngineState>();
    let Some(mut child) = state.0.lock().unwrap().take() else {
        return false;
    };
    let _ = child.write(b"{\"cmd\":\"shutdown\"}\n");
    // Give it a moment to release the capture, then make sure it is gone.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(3));
        let _ = child.kill();
    });
    true
}
