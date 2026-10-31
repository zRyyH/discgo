//! Session token in the Windows Credential Manager (PLAN 7.2). The service is the app
//! identifier, so DiscGo and DiscGo Dev (PLAN fase 10.6) keep separate sessions.

use tauri::AppHandle;

const ACCOUNT: &str = "session";

fn entry(app: &AppHandle) -> Result<keyring::Entry, String> {
    keyring::Entry::new(&app.config().identifier, ACCOUNT).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_get(app: AppHandle) -> Result<Option<String>, String> {
    match entry(&app)?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn session_set(app: AppHandle, token: String) -> Result<(), String> {
    entry(&app)?.set_password(&token).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_clear(app: AppHandle) -> Result<(), String> {
    match entry(&app)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
