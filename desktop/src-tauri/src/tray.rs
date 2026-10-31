//! Windows tray (PLAN fase 9D). Closing the window hides it here instead of
//! quitting, like Discord; "Sair do DiscGo" in the menu is the way out. The
//! icon follows the voice state the UI reports with `tray_set_state` (in a
//! call, speaking, muted), and the menu's mute/deafen go back to the UI as
//! `tray://toggle-mute` / `tray://toggle-deaf`.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime, include_image};

const TRAY_ID: &str = "main";

pub struct TrayState {
    mute: CheckMenuItem<tauri::Wry>,
    deaf: CheckMenuItem<tauri::Wry>,
    /// "Manter na bandeja ao fechar" in Settings; when off, closing quits.
    close_to_tray: AtomicBool,
}

/// Drawn by desktop/scripts/tray-icons.mjs.
fn icon(state: &str) -> Image<'static> {
    match state {
        "voice" => include_image!("icons/tray/voice.png"),
        "speaking" => include_image!("icons/tray/speaking.png"),
        "muted" => include_image!("icons/tray/muted.png"),
        _ => include_image!("icons/tray/idle.png"),
    }
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    // "DiscGo", or "DiscGo Dev" for the development app (PLAN fase 10.6).
    let name = app.package_info().name.clone();
    let open = MenuItem::with_id(app, "open", format!("Abrir o {name}"), true, None::<&str>)?;
    let mute = CheckMenuItem::with_id(app, "mute", "Silenciar", true, false, None::<&str>)?;
    let deaf = CheckMenuItem::with_id(app, "deaf", "Ensurdecer", true, false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", format!("Sair do {name}"), true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &PredefinedMenuItem::separator(app)?,
            &mute,
            &deaf,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon("idle"))
        .tooltip(&name)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id().as_ref() {
            "open" => show_main(app),
            "mute" => {
                let _ = app.emit("tray://toggle-mute", ());
            }
            "deaf" => {
                let _ = app.emit("tray://toggle-deaf", ());
            }
            "quit" => {
                // The engine also exits on stdin EOF; this lets it release the capture first.
                crate::engine::engine_stop(app.clone());
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = e
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    app.manage(TrayState {
        mute,
        deaf,
        close_to_tray: AtomicBool::new(true),
    });
    Ok(())
}

pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub fn closes_to_tray(app: &AppHandle) -> bool {
    app.try_state::<TrayState>()
        .is_some_and(|s| s.close_to_tray.load(Ordering::Relaxed))
}

/// `state`: "idle" (not in voice), "voice", "speaking" or "muted".
#[tauri::command]
pub fn tray_set_state(app: AppHandle, state: String, tooltip: String, mute: bool, deaf: bool) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_icon(Some(icon(&state)));
        let _ = tray.set_tooltip(Some(tooltip));
    }
    if let Some(s) = app.try_state::<TrayState>() {
        let _ = s.mute.set_checked(mute);
        let _ = s.deaf.set_checked(deaf);
    }
}

#[tauri::command]
pub fn tray_close_to_tray(app: AppHandle, enabled: bool) {
    if let Some(s) = app.try_state::<TrayState>() {
        s.close_to_tray.store(enabled, Ordering::Relaxed);
    }
}
