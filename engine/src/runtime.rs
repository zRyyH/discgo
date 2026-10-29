//! Points GStreamer at the bundled runtime (PLAN 6.10) before `gst::init`.
//!
//! Core DLLs are resolved by the loader from the executable's directory. Plugins
//! are looked up, in order, in:
//! 1. `DISCGO_GST_PLUGIN_DIR`
//! 2. `<exe_dir>/resources/gst/plugins` (installed app and staged runtime)
//!
//! If none exists the system GStreamer installation is used (development).

use std::path::{Path, PathBuf};

pub enum Runtime {
    Bundled(PathBuf),
    System,
}

pub fn configure() -> Runtime {
    let Some(dir) = plugin_dir() else {
        return Runtime::System;
    };
    // SAFETY: called from main before any other thread exists.
    unsafe {
        std::env::set_var("GST_PLUGIN_SYSTEM_PATH", &dir);
        std::env::set_var("GST_PLUGIN_PATH", &dir);
        // Scan in-process: we do not ship gst-plugin-scanner.exe.
        std::env::set_var("GST_REGISTRY_FORK", "no");
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let registry = Path::new(&local).join("discgo").join("gst-registry.bin");
            let _ = std::fs::create_dir_all(registry.parent().unwrap());
            std::env::set_var("GST_REGISTRY", registry);
        }
    }
    Runtime::Bundled(dir)
}

fn plugin_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("DISCGO_GST_PLUGIN_DIR") {
        return Some(PathBuf::from(dir));
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?.join("resources").join("gst").join("plugins");
    dir.is_dir().then_some(dir)
}
