//! Process helpers.

use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::GetCurrentProcessId;

/// PID of the process that spawned the engine (the desktop shell).
pub fn parent_pid() -> Option<u32> {
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
        let me = GetCurrentProcessId();
        let mut entry = PROCESSENTRY32W {
            dwSize: size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut found = None;
        let mut ok = Process32FirstW(snapshot, &mut entry).is_ok();
        while ok {
            if entry.th32ProcessID == me {
                found = Some(entry.th32ParentProcessID);
                break;
            }
            ok = Process32NextW(snapshot, &mut entry).is_ok();
        }
        let _ = CloseHandle(snapshot);
        found
    }
}
