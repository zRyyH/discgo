//! Engine ⇄ shell protocol (PLAN 6.8): one JSON object per line on stdin
//! (commands) and stdout (events). Mirror of desktop/src/shared/engine.ts — keep
//! both in sync.

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Command {
    Probe {
        /// Ignore the cached probe result and test every encoder again.
        #[serde(default)]
        force: bool,
    },
    ListSources,
    Start(StartParams),
    Update {
        preset: Option<Preset>,
        content_mode: Option<ContentMode>,
    },
    Sdp {
        session_id: String,
        #[serde(rename = "type")]
        kind: SdpKind,
        sdp: String,
    },
    Ice {
        session_id: String,
        candidate: String,
        sdp_mid: Option<String>,
        sdp_m_line_index: u32,
    },
    Stop,
    Shutdown,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StartParams {
    pub target: Target,
    pub source: SourceRef,
    #[serde(default)]
    pub preset: Preset,
    #[serde(default)]
    pub codec: Codec,
    #[serde(default)]
    pub content_mode: ContentMode,
    #[serde(default)]
    pub system_audio: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Target {
    Livekit {
        url: String,
        token: String,
    },
    P2p {
        session_id: String,
        /// "stun://host:port"; the same server the UI uses.
        #[serde(default)]
        stun_server: Option<String>,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SourceRef {
    /// `id` is the HMONITOR from `sources`.
    Monitor { id: String },
    /// `id` is the HWND from `sources`.
    Window { id: String },
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum Preset {
    #[serde(rename = "720p30")]
    P720p30,
    #[serde(rename = "1080p30")]
    P1080p30,
    #[default]
    #[serde(rename = "1080p60")]
    P1080p60,
    #[serde(rename = "1440p60")]
    P1440p60,
    #[serde(rename = "native60")]
    Native60,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContentMode {
    /// Keep resolution, drop fps under congestion.
    #[default]
    Text,
    /// Keep 60 fps, drop resolution under congestion.
    Motion,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SdpKind {
    Offer,
    Answer,
}

#[derive(Debug, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
    Ready {
        gst_version: String,
        encoders: Vec<EncoderInfo>,
        warnings: Vec<String>,
    },
    Sources {
        monitors: Vec<MonitorInfo>,
        windows: Vec<WindowInfo>,
    },
    Started {
        encoder: String,
        adapter: Option<AdapterInfo>,
        zero_copy: bool,
        codec: Codec,
        width: i32,
        height: i32,
        fps: i32,
    },
    Sdp {
        session_id: String,
        #[serde(rename = "type")]
        kind: SdpKind,
        sdp: String,
    },
    Ice {
        session_id: String,
        candidate: String,
        sdp_mid: Option<String>,
        sdp_m_line_index: u32,
    },
    Stats(Stats),
    Stopped,
    Error {
        code: String,
        message: String,
        fatal: bool,
    },
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Stats {
    pub fps_captured: f32,
    pub fps_encoded: f32,
    pub bitrate_kbps: u32,
    /// Bitrate the congestion controller currently allows.
    pub target_kbps: u32,
    pub encode_ms_p50: f32,
    pub encode_ms_p99: f32,
    /// Frames captured but not encoded (leaky queue, fps limiter) in the last second.
    pub dropped: u32,
    pub width: i32,
    pub height: i32,
    pub fps_limit: i32,
    pub rtt_ms: Option<f32>,
    pub loss: Option<f32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MonitorInfo {
    pub id: String,
    pub name: String,
    pub primary: bool,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub adapter: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WindowInfo {
    pub id: String,
    pub title: String,
    pub process: String,
    pub width: i32,
    pub height: i32,
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

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Codec {
    #[default]
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

impl Preset {
    /// (max width, max height, fps, bitrate kbit/s); width/height 0 = source size.
    pub fn params(self) -> (i32, i32, i32, u32) {
        match self {
            Preset::P720p30 => (1280, 720, 30, 3_000),
            Preset::P1080p30 => (1920, 1080, 30, 5_000),
            Preset::P1080p60 => (1920, 1080, 60, 8_000),
            Preset::P1440p60 => (2560, 1440, 60, 12_000),
            Preset::Native60 => (0, 0, 60, 16_000),
        }
    }
}
