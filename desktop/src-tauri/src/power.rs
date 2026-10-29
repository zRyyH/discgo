//! Keeps the display on while sharing the screen (PLAN 7.2).

use windows::Win32::System::Power::{ES_CONTINUOUS, ES_DISPLAY_REQUIRED, SetThreadExecutionState};

/// Applies to the calling thread; Tauri runs sync commands on the main thread,
/// which lives as long as the app.
#[tauri::command]
pub fn power_keep_display(on: bool) {
    let flags = if on {
        ES_CONTINUOUS | ES_DISPLAY_REQUIRED
    } else {
        ES_CONTINUOUS
    };
    unsafe {
        SetThreadExecutionState(flags);
    }
}
