//! Capture → encode → WebRTC pipeline (PLAN 6.1, mode B — see PLAN 13):
//!
//!   d3d11screencapturesrc ! D3D11 caps ! videorate (fps limiter) ! d3d11convert
//!     ! D3D11 NV12 WxH ! queue (leaky) ! HW encoder ! parser ! livekitwebrtcsink | webrtcsink
//!
//! The frame stays in D3D11 memory until the encoder. The sink runs Google
//! Congestion Control on the pre-encoded stream and reports the allowed bitrate
//! through `define-encoder-bitrates`; we apply it to the encoder and, below a
//! threshold, trade fps (text) or resolution (motion) for quality (PLAN 6.3).

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use gst::prelude::*;
use gstreamer as gst;
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
use windows::Win32::Graphics::Gdi::{HMONITOR, MONITOR_DEFAULTTONEAREST, MonitorFromWindow};

use crate::encoder;
use crate::protocol::{
    Codec, ContentMode, EncoderInfo, Event, Preset, SdpKind, SourceRef, StartParams, Stats, Target,
};
use crate::signaller_gateway::GatewaySignaller;
use crate::stats::{self, Collector};
use crate::{emit, sources};

const MIN_BITRATE_KBPS: u32 = 500;

/// rtpgccbwe paces packets at exactly its estimate. Letting the estimate run above
/// the encoder cap makes each frame leave faster than one frame interval (libwebrtc
/// paces at 2.5x for the same reason); the encoder itself stays capped at the preset.
fn pacing_headroom() -> f64 {
    std::env::var("DISCGO_ENGINE_PACING_HEADROOM")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(2.5)
}

pub struct Session {
    pipeline: gst::Pipeline,
    signaller: Option<GatewaySignaller>,
    shared: Arc<Shared>,
    stop: Arc<AtomicBool>,
    threads: Vec<JoinHandle<()>>,
}

/// State touched from the bitrate callback, the stats thread and `update`.
struct Shared {
    encoder: gst::Element,
    rate: gst::Element,
    scale_filter: gst::Element,
    sink: gst::Element,
    collector: Arc<Collector>,
    /// What the encoder actually produced over the last second.
    sent_kbps: AtomicU32,
    source_size: (i32, i32),
    adapt: Mutex<Adapt>,
}

struct Adapt {
    preset: Preset,
    content_mode: ContentMode,
    target_kbps: u32,
    applied_kbps: u32,
    /// 0 = full quality; each step halves fps (text) or lowers resolution (motion).
    level: usize,
    low_since: Option<Instant>,
    high_since: Option<Instant>,
    width: i32,
    height: i32,
    fps: i32,
}

#[derive(Clone, Copy, PartialEq)]
enum CaptureApi {
    Wgc,
    Dxgi,
}

impl Session {
    pub fn start(params: &StartParams, encoders: &[EncoderInfo]) -> Result<Session> {
        if std::env::var("DISCGO_ENGINE_CAPTURE_API").as_deref() == Ok("dxgi") {
            return Self::build(params, encoders, CaptureApi::Dxgi);
        }
        match Self::build(params, encoders, CaptureApi::Wgc) {
            Ok(s) => Ok(s),
            Err(e) if matches!(params.source, SourceRef::Monitor { .. }) => {
                log::warn!("WGC capture failed ({e:#}), retrying with DXGI desktop duplication");
                Self::build(params, encoders, CaptureApi::Dxgi)
            }
            Err(e) => Err(e),
        }
    }

    fn build(params: &StartParams, encoders: &[EncoderInfo], api: CaptureApi) -> Result<Session> {
        let (source_size, monitor) = source_geometry(&params.source)?;
        let capture_adapter = sources::adapter_for_monitor(monitor);
        let (info, same_adapter) = encoder::select(encoders, params.codec, capture_adapter)
            .ok_or_else(|| anyhow!("no usable encoder; run probe first"))?;
        let (_, _, fps, kbps) = params.preset.params();
        let (width, height) = fit(source_size, params.preset);
        let adapter = info.adapter.as_ref().map_or(0, |a| a.index);
        log::info!(
            "start: source {source_size:?} -> {width}x{height}@{fps}, encoder {} (same adapter: {same_adapter}), {kbps} kbit/s",
            info.name
        );

        let pipeline = gst::Pipeline::with_name("capture");
        let src = make("d3d11screencapturesrc")?;
        src.set_property("show-cursor", true);
        match api {
            CaptureApi::Wgc => {
                src.set_property_from_str("capture-api", "wgc");
                src.set_property("show-border", false);
                // The device the WGC frames are delivered on: the encoder's adapter.
                if info.adapter.is_some() {
                    src.set_property("adapter", adapter as i32);
                }
            }
            CaptureApi::Dxgi => src.set_property_from_str("capture-api", "dxgi"),
        }
        match &params.source {
            SourceRef::Monitor { id } => src.set_property("monitor-handle", parse_handle(id)?),
            SourceRef::Window { id } => src.set_property("window-handle", parse_handle(id)?),
        }
        let src_caps = make("capsfilter")?;
        src_caps.set_property(
            "caps",
            gst::Caps::builder("video/x-raw")
                .features(["memory:D3D11Memory"])
                .field("framerate", gst::Fraction::new(fps, 1))
                .build(),
        );
        let rate = make("videorate")?;
        rate.set_property("drop-only", true);
        rate.set_property("max-rate", fps);
        let convert = make("d3d11convert")?;
        convert.set_property("add-borders", true);
        let scale_filter = make("capsfilter")?;
        scale_filter.set_property("caps", scaled_caps(width, height));
        let queue = make("queue")?;
        queue.set_property_from_str("leaky", "downstream");
        queue.set_property("max-size-buffers", 1u32);
        queue.set_property("max-size-bytes", 0u32);
        queue.set_property("max-size-time", 0u64);

        let enc = make(&info.name)?;
        encoder::configure(&enc, &info, kbps, fps);
        let parse = make(if info.codec == Codec::Av1 {
            "av1parse"
        } else {
            "h264parse"
        })?;
        if parse.find_property("config-interval").is_some() {
            parse.set_property("config-interval", -1i32);
        }

        let sink = match &params.target {
            Target::Livekit { url, token } => {
                let sink = make("livekitwebrtcsink")?;
                let signaller = sink.property::<glib::Object>("signaller");
                signaller.set_property("ws-url", url);
                signaller.set_property("auth-token", token);
                sink
            }
            Target::P2p { stun_server, .. } => {
                let sink = make("webrtcsink")?;
                sink.set_property("stun-server", stun_server.as_deref());
                sink
            }
        };
        let cc = std::env::var("DISCGO_ENGINE_CC").unwrap_or_else(|_| "gcc".into());
        sink.set_property_from_str("congestion-control", &cc);
        // ULPFEC doubled the bitrate on the wire in the spike; NACK/RTX covers loss.
        sink.set_property("do-fec", false);
        sink.set_property("start-bitrate", kbps * 1000);
        sink.set_property(
            "max-bitrate",
            (kbps as f64 * 1000.0 * pacing_headroom()) as u32,
        );
        sink.set_property("min-bitrate", MIN_BITRATE_KBPS.min(kbps) * 1000);
        let signaller = match &params.target {
            Target::P2p { session_id, .. } => {
                let s = GatewaySignaller::new(session_id);
                sink.set_property("signaller", &s);
                Some(s)
            }
            Target::Livekit { .. } => None,
        };

        let mut chain = vec![&src, &src_caps, &rate, &convert, &scale_filter, &queue];
        let download;
        if !info.d3d11 {
            download = make("d3d11download")?;
            chain.push(&download);
        }
        chain.extend([&enc, &parse]);
        pipeline.add_many(chain.iter().copied().chain([&sink]))?;
        gst::Element::link_many(chain.iter().copied())?;
        let video_pad = sink
            .request_pad_simple("video_%u")
            .context("request video pad")?;
        parse.static_pad("src").unwrap().link(&video_pad)?;

        if params.system_audio && matches!(params.source, SourceRef::Monitor { .. }) {
            add_system_audio(&pipeline, &sink)?;
        }

        let collector = Arc::new(Collector::default());
        collector.attach(
            &src_caps.static_pad("src").unwrap(),
            &enc.static_pad("sink").unwrap(),
            &enc.static_pad("src").unwrap(),
        );

        let shared = Arc::new(Shared {
            encoder: enc.clone(),
            rate,
            scale_filter,
            sink: sink.clone(),
            collector,
            sent_kbps: AtomicU32::new(0),
            source_size,
            adapt: Mutex::new(Adapt {
                preset: params.preset,
                content_mode: params.content_mode,
                target_kbps: kbps,
                applied_kbps: kbps,
                level: 0,
                low_since: None,
                high_since: None,
                width,
                height,
                fps,
            }),
        });

        let weak = Arc::downgrade(&shared);
        sink.connect("define-encoder-bitrates", false, move |args| {
            let overall = args[2].get::<i32>().unwrap_or(0).max(0) as u32;
            if let Some(shared) = weak.upgrade() {
                shared.on_bandwidth(overall / 1000);
            }
            Some(args[3].clone())
        });

        // `started` once the first frame reaches the encoder: caps are negotiated by then.
        let started = Arc::new(AtomicBool::new(false));
        let chain_pads: Vec<gst::Pad> = [
            &src,
            &src_caps,
            &shared.rate,
            &convert,
            &shared.scale_filter,
            &queue,
        ]
        .iter()
        .map(|e| e.static_pad("src").unwrap())
        .chain(std::iter::once(enc.static_pad("sink").unwrap()))
        .collect();
        let shared_for_start = shared.clone();
        enc.static_pad("sink")
            .unwrap()
            .add_probe(gst::PadProbeType::BUFFER, move |_, _| {
                if !started.swap(true, Ordering::SeqCst) {
                    let zero_copy = same_adapter && chain_pads.iter().all(is_d3d11);
                    let a = shared_for_start.adapt.lock().unwrap();
                    emit(&Event::Started {
                        encoder: info.name.clone(),
                        adapter: info.adapter.clone(),
                        zero_copy,
                        codec: info.codec,
                        width: a.width,
                        height: a.height,
                        fps: a.fps,
                    });
                }
                gst::PadProbeReturn::Remove
            });

        // The sink re-times every frame with a clocksync against the pipeline latency.
        // Frames are encoded long before the latency the elements report, so that
        // wait is pure added delay: deliver frames as soon as they are encoded.
        if std::env::var_os("DISCGO_ENGINE_KEEP_LATENCY").is_none() {
            pipeline.set_latency(Some(gst::ClockTime::ZERO));
        }

        share_device(&pipeline, adapter);
        pipeline
            .set_state(gst::State::Playing)
            .context("set Playing")?;
        remember_device(&convert, adapter);
        // A capture source that cannot start fails within a few hundred ms.
        let bus = pipeline.bus().unwrap();
        if let Some(msg) = bus.timed_pop_filtered(
            gst::ClockTime::from_mseconds(1500),
            &[gst::MessageType::Error],
        ) {
            let _ = pipeline.set_state(gst::State::Null);
            if let gst::MessageView::Error(err) = msg.view() {
                bail!("{} ({:?})", err.error(), err.debug());
            }
        }

        let stop = Arc::new(AtomicBool::new(false));
        let threads = vec![
            spawn_bus_watch(pipeline.clone(), stop.clone()),
            spawn_stats(shared.clone(), stop.clone()),
        ];
        Ok(Session {
            pipeline,
            signaller,
            shared,
            stop,
            threads,
        })
    }

    pub fn update(&self, preset: Option<Preset>, content_mode: Option<ContentMode>) {
        let mut a = self.shared.adapt.lock().unwrap();
        if let Some(m) = content_mode {
            a.content_mode = m;
        }
        if let Some(p) = preset {
            a.preset = p;
            let (_, _, _, kbps) = p.params();
            self.shared.sink.set_property(
                "max-bitrate",
                (kbps as f64 * 1000.0 * pacing_headroom()) as u32,
            );
            a.target_kbps = a.target_kbps.min(kbps);
        }
        a.level = 0;
        self.shared.apply(&mut a);
    }

    pub fn handle_sdp(&self, session_id: &str, kind: SdpKind, sdp: &str) -> Result<()> {
        self.signaller
            .as_ref()
            .context("not a p2p session")?
            .handle_sdp(session_id, kind, sdp)
    }

    pub fn handle_ice(
        &self,
        session_id: &str,
        candidate: &str,
        sdp_m_line_index: u32,
        sdp_mid: Option<String>,
    ) -> Result<()> {
        self.signaller
            .as_ref()
            .context("not a p2p session")?
            .handle_ice(session_id, candidate, sdp_m_line_index, sdp_mid);
        Ok(())
    }

    pub fn is_alive(&self) -> bool {
        !self.stop.load(Ordering::SeqCst)
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = self.pipeline.set_state(gst::State::Null);
        for t in self.threads.drain(..) {
            let _ = t.join();
        }
    }
}

impl Shared {
    /// Called by the congestion controller with the bitrate the link allows.
    fn on_bandwidth(&self, kbps: u32) {
        let mut a = self.adapt.lock().unwrap();
        let (_, _, _, max_kbps) = a.preset.params();
        let kbps = kbps.clamp(MIN_BITRATE_KBPS.min(max_kbps), max_kbps);
        // GCC caps its estimate near the acknowledged rate, so a mostly static
        // screen (few, small frames) would drag the encoder down to the minimum and
        // the next burst of motion would start blurry. While the stream is
        // application-limited, ignore decreases: they are not congestion.
        let app_limited = self.sent_kbps.load(Ordering::Relaxed) < a.applied_kbps * 65 / 100;
        if app_limited && kbps < a.applied_kbps {
            return;
        }
        a.target_kbps = kbps;

        // Hysteresis: step down after 2 s below the threshold, up after 5 s above 70 %.
        let ratio = a.target_kbps as f32 / max_kbps as f32;
        let down_at = if a.content_mode == ContentMode::Text {
            0.4
        } else {
            0.5
        };
        let now = Instant::now();
        let mut changed = false;
        if ratio < down_at && a.level < 2 {
            a.high_since = None;
            let since = *a.low_since.get_or_insert(now);
            if now.duration_since(since) >= Duration::from_secs(2) {
                a.level += 1;
                a.low_since = None;
                changed = true;
            }
        } else if ratio > 0.7 && a.level > 0 {
            a.low_since = None;
            let since = *a.high_since.get_or_insert(now);
            if now.duration_since(since) >= Duration::from_secs(5) {
                a.level -= 1;
                a.high_since = None;
                changed = true;
            }
        } else {
            a.low_since = None;
            a.high_since = None;
        }
        if changed {
            log::info!(
                "adapt: level {} ({:?}) at {} kbit/s",
                a.level,
                a.content_mode,
                a.target_kbps
            );
            self.apply(&mut a);
        } else if a.target_kbps.abs_diff(a.applied_kbps) * 100 > a.applied_kbps * 3 {
            a.applied_kbps = a.target_kbps;
            encoder::set_bitrate(&self.encoder, a.target_kbps);
        }
    }

    /// Applies preset, adaptation level and target bitrate to the live pipeline.
    fn apply(&self, a: &mut Adapt) {
        let (_, _, preset_fps, _) = a.preset.params();
        let (full_w, full_h) = fit(self.source_size, a.preset);
        let (w, h, fps) = match a.content_mode {
            ContentMode::Text => (full_w, full_h, (preset_fps >> a.level).max(15)),
            ContentMode::Motion => {
                let steps = [full_h, 1080, 720].into_iter().filter(|&s| s <= full_h);
                let mut heights: Vec<i32> = steps.collect();
                heights.dedup();
                let target_h = heights[a.level.min(heights.len() - 1)];
                let w = even((full_w as i64 * target_h as i64 / full_h as i64) as i32);
                (w, target_h, preset_fps)
            }
        };
        if (w, h) != (a.width, a.height) {
            self.scale_filter.set_property("caps", scaled_caps(w, h));
            a.width = w;
            a.height = h;
        }
        if fps != a.fps {
            self.rate.set_property("max-rate", fps);
            a.fps = fps;
        }
        a.applied_kbps = a.target_kbps;
        encoder::set_bitrate(&self.encoder, a.target_kbps);
    }
}

fn spawn_bus_watch(pipeline: gst::Pipeline, stop: Arc<AtomicBool>) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let bus = pipeline.bus().unwrap();
        while !stop.load(Ordering::SeqCst) {
            let Some(msg) = bus.timed_pop(gst::ClockTime::from_mseconds(200)) else {
                continue;
            };
            match msg.view() {
                gst::MessageView::Error(err) => {
                    let src = msg
                        .src()
                        .map(|s| s.path_string().to_string())
                        .unwrap_or_default();
                    log::error!(
                        "pipeline error from {src}: {} ({:?})",
                        err.error(),
                        err.debug()
                    );
                    emit(&Event::Error {
                        code: "pipeline".into(),
                        message: err.error().to_string(),
                        fatal: true,
                    });
                    stop.store(true, Ordering::SeqCst);
                    let _ = pipeline.set_state(gst::State::Null);
                    emit(&Event::Stopped);
                }
                gst::MessageView::Warning(w) => {
                    log::warn!("pipeline warning: {} ({:?})", w.error(), w.debug())
                }
                _ => {}
            }
        }
    })
}

fn spawn_stats(shared: Arc<Shared>, stop: Arc<AtomicBool>) -> JoinHandle<()> {
    std::thread::spawn(move || {
        shared.collector.snapshot(); // reset the window
        while !stop.load(Ordering::SeqCst) {
            for _ in 0..10 {
                std::thread::sleep(Duration::from_millis(100));
                if stop.load(Ordering::SeqCst) {
                    return;
                }
            }
            let s = shared.collector.snapshot();
            shared.sent_kbps.store(s.bitrate_kbps, Ordering::Relaxed);
            let (rtt_ms, loss) = shared
                .sink
                .property::<Option<gst::Structure>>("stats")
                .map(|st| stats::transport_stats(&st))
                .unwrap_or((None, None));
            let a = shared.adapt.lock().unwrap();
            emit(&Event::Stats(Stats {
                fps_captured: s.fps_captured,
                fps_encoded: s.fps_encoded,
                bitrate_kbps: s.bitrate_kbps,
                target_kbps: a.target_kbps,
                encode_ms_p50: s.encode_ms_p50,
                encode_ms_p99: s.encode_ms_p99,
                dropped: s.dropped,
                width: a.width,
                height: a.height,
                fps_limit: a.fps,
                rtt_ms,
                loss,
            }));
        }
    })
}

fn add_system_audio(pipeline: &gst::Pipeline, sink: &gst::Element) -> Result<()> {
    let src = make("wasapi2src")?;
    src.set_property("loopback", true);
    src.set_property("low-latency", true);
    // Leave the shell (and its WebView2 children, i.e. the voice call) out of the mix.
    if let (Some(_), Some(pid)) = (
        src.find_property("loopback-mode"),
        crate::process::parent_pid(),
    ) {
        src.set_property_from_str("loopback-mode", "exclude-process-tree");
        src.set_property("loopback-target-pid", pid);
    }
    let convert = make("audioconvert")?;
    let resample = make("audioresample")?;
    let caps = make("capsfilter")?;
    caps.set_property(
        "caps",
        gst::Caps::builder("audio/x-raw")
            .field("rate", 48000)
            .field("channels", 2)
            .build(),
    );
    let opus = make("opusenc")?;
    opus.set_property("bitrate", 128_000i32);
    opus.set_property_from_str("frame-size", "20");
    opus.set_property_from_str("audio-type", "generic");
    pipeline.add_many([&src, &convert, &resample, &caps, &opus])?;
    gst::Element::link_many([&src, &convert, &resample, &caps, &opus])?;
    let pad = sink
        .request_pad_simple("audio_%u")
        .context("request audio pad")?;
    opus.static_pad("src").unwrap().link(&pad)?;
    Ok(())
}

fn make(factory: &str) -> Result<gst::Element> {
    gst::ElementFactory::make(factory)
        .build()
        .with_context(|| format!("element {factory} not available"))
}

fn scaled_caps(width: i32, height: i32) -> gst::Caps {
    gst::Caps::builder("video/x-raw")
        .features(["memory:D3D11Memory"])
        .field("format", "NV12")
        .field("width", width)
        .field("height", height)
        .field("pixel-aspect-ratio", gst::Fraction::new(1, 1))
        .build()
}

fn is_d3d11(pad: &gst::Pad) -> bool {
    pad.current_caps().is_some_and(|c| {
        c.features(0)
            .is_some_and(|f| f.contains("memory:D3D11Memory"))
    })
}

/// Output size: the source scaled to fit the preset box, never upscaled, even.
fn fit((sw, sh): (i32, i32), preset: Preset) -> (i32, i32) {
    let (bw, bh, _, _) = preset.params();
    if bw == 0 || (sw <= bw && sh <= bh) {
        return (even(sw.min(4096)), even(sh.min(4096)));
    }
    let scale = (bw as f64 / sw as f64).min(bh as f64 / sh as f64);
    (
        even((sw as f64 * scale) as i32),
        even((sh as f64 * scale) as i32),
    )
}

fn even(v: i32) -> i32 {
    (v.max(2)) & !1
}

fn parse_handle(id: &str) -> Result<u64> {
    id.parse::<u64>()
        .with_context(|| format!("bad source id {id:?}"))
}

/// Source size in physical pixels and the monitor it is on.
fn source_geometry(source: &SourceRef) -> Result<((i32, i32), HMONITOR)> {
    match source {
        SourceRef::Monitor { id } => {
            let handle = parse_handle(id)?;
            let m = sources::monitors()
                .into_iter()
                .find(|m| m.id == id.as_str())
                .with_context(|| format!("monitor {id} not found"))?;
            Ok(((m.width, m.height), HMONITOR(handle as *mut _)))
        }
        SourceRef::Window { id } => {
            let hwnd = HWND(parse_handle(id)? as *mut _);
            let mut r = RECT::default();
            unsafe {
                DwmGetWindowAttribute(
                    hwnd,
                    DWMWA_EXTENDED_FRAME_BOUNDS,
                    &mut r as *mut _ as *mut _,
                    size_of::<RECT>() as u32,
                )
                .context("window not found")?;
                Ok((
                    (r.right - r.left, r.bottom - r.top),
                    MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST),
                ))
            }
        }
    }
}

/// One D3D11 device per adapter for the life of the engine. Each WGC capture
/// otherwise creates its own device, and d3d11screencapturesrc never releases
/// it (≈95 MB and ≈40 driver threads per start/stop on NVIDIA, measured in phase 1).
static DEVICES: std::sync::LazyLock<Mutex<std::collections::HashMap<u32, gst::Context>>> =
    std::sync::LazyLock::new(Default::default);
const D3D11_CONTEXT: &str = "gst.d3d11.device.handle";

fn share_device(pipeline: &gst::Pipeline, adapter: u32) {
    if let Some(ctx) = DEVICES.lock().unwrap().get(&adapter) {
        pipeline.set_context(ctx);
    }
}

fn remember_device(element: &gst::Element, adapter: u32) {
    let mut devices = DEVICES.lock().unwrap();
    if devices.contains_key(&adapter) {
        return;
    }
    let mut q = gst::query::Context::new(D3D11_CONTEXT);
    if element.query(&mut q)
        && let Some(ctx) = q.context()
    {
        devices.insert(adapter, ctx.to_owned());
    }
}
