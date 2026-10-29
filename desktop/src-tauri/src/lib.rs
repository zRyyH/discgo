//! DiscGo desktop shell. Keep this crate thin (PLAN 7.2): it is the part that
//! would be replaced if the shell moved back to Electron.

mod engine;
mod power;
mod secrets;
mod webview;

use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

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
        // Must be first: a second launch (e.g. the browser opening discgo://auth?code=…)
        // hands its URL to the running instance and exits.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(engine::EngineState::default())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .on_permission_request(webview::on_permission_request)
        .setup(|app| {
            // Installed builds get the scheme from the installer; dev builds register it here.
            #[cfg(debug_assertions)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(e) = app.deep_link().register_all() {
                    log::warn!("deep link registration failed: {e}");
                }
            }
            let _ = app;
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running DiscGo");
}
