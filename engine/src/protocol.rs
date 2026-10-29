//! Engine ⇄ shell protocol: one JSON object per line on stdin (commands) and
//! stdout (events). Mirror of desktop/src/shared/engine.ts — keep both in sync.

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Command {
    Probe {
        /// Ignore the cached probe result and test every encoder again.
        #[serde(default)]
        force: bool,
    },
    Shutdown,
}

#[derive(Debug, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
    Ready {
        gst_version: String,
        encoders: Vec<EncoderInfo>,
        warnings: Vec<String>,
    },
    Error {
        code: String,
        message: String,
        fatal: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Vendor {
    Nvidia,
    Amd,
    Intel,
    Microsoft,
    Software,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Codec {
    H264,
    Av1,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncoderInfo {
    /// GStreamer element factory name, e.g. "nvd3d11h264enc".
    pub name: String,
    pub vendor: Vendor,
    pub codec: Codec,
    pub hardware: bool,
    /// Accepts video/x-raw(memory:D3D11Memory) input.
    pub d3d11: bool,
    /// DXGI adapter the encoder runs on; None for software encoders.
    pub adapter: Option<AdapterInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AdapterInfo {
    pub index: u32,
    pub luid: i64,
    pub description: String,
    pub vendor_id: u32,
    pub device_id: u32,
}
