//! DiscGo desktop shell. Keep this crate thin (PLAN 7.2): it is the part that
//! would be replaced if the shell moved back to Electron.

mod engine;
mod power;
mod secrets;
mod tray;
mod webview;

use tauri::{Manager, WindowEvent};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::StateFlags;

/// Passed by the "Iniciar com o Windows" entry: start hidden in the tray.
const AUTOSTART_ARG: &str = "--autostart";

#[tauri::command]
fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Opens an http(s) URL in the system browser (Google login, links in chat).
#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|e| e.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("only http(s) URLs can be opened".into());
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        // Must be first: a second launch (e.g. the browser opening discgo://auth?code=…,
        // or the Start menu while the window is in the tray) hands over and exits.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            tray::show_main(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(engine::EngineState::default())
        .plugin(tauri_plugin_store::Builder::new().build())
        // Visibility is ours (tray, autostart), not a restored state.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![AUTOSTART_ARG]),
        ))
        .on_permission_request(webview::on_permission_request)
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event
                && window.label() == "main"
                && tray::closes_to_tray(window.app_handle())
            {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            // Installed builds get the scheme from the installer; dev builds register it here.
            #[cfg(debug_assertions)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(e) = app.deep_link().register_all() {
                    log::warn!("deep link registration failed: {e}");
                }
            }
            tray::setup(app.handle())?;
            // The window starts hidden (tauri.conf.json) so a login start stays in the tray.
            if !std::env::args().any(|a| a == AUTOSTART_ARG) {
                tray::show_main(app.handle());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_version,
            open_external,
            secrets::session_get,
            secrets::session_set,
            secrets::session_clear,
            engine::engine_start,
            engine::engine_send,
            engine::engine_stop,
            power::power_keep_display,
            tray::tray_set_state,
            tray::tray_close_to_tray,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DiscGo");
}
