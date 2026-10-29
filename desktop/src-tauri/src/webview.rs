//! WebView2 policy (PLAN 2.1, 7.2): grant microphone, camera and autoplay to the
//! app's own origin without a prompt; everything else keeps WebView2's default.
//! Browser args against background throttling live in tauri.conf.json.

use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::{Runtime, Webview};

pub fn on_permission_request<R: Runtime>(
    webview: Webview<R>,
    kind: PermissionKind,
) -> PermissionResponse {
    let trusted = webview.url().is_ok_and(|u| is_app_origin(&u));
    match kind {
        PermissionKind::Microphone | PermissionKind::Camera | PermissionKind::Autoplay
            if trusted =>
        {
            PermissionResponse::Allow
        }
        _ => PermissionResponse::Default,
    }
}

fn is_app_origin(url: &tauri::Url) -> bool {
    match (url.scheme(), url.host_str()) {
        ("http" | "https", Some("tauri.localhost")) | ("tauri", Some("localhost")) => true,
        // Vite dev server
        ("http", Some("localhost")) => cfg!(debug_assertions),
        _ => false,
    }
}
