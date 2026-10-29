//! DiscGo desktop shell. Keep this crate thin (PLAN 7.2): it is the part that
//! would be replaced if the shell moved back to Electron.

mod webview;

#[tauri::command]
fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

pub fn run() {
    tauri::Builder::default()
        .on_permission_request(webview::on_permission_request)
        .invoke_handler(tauri::generate_handler![app_version])
        .run(tauri::generate_context!())
        .expect("error while running DiscGo");
}
