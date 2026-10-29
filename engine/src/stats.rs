//! Per-second capture/encode statistics (PLAN 6.8 `stats`), gathered with pad
//! probes so nothing in the media path changes.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::Instant;

use gst::prelude::*;
use gstreamer as gst;

#[derive(Default)]
pub struct Collector {
    captured: AtomicU32,
    entered: AtomicU32,
    encoded: AtomicU32,
    bytes: AtomicU64,
    /// When each frame still inside the encoder entered it.
    in_flight: Mutex<VecDeque<Instant>>,
    encode_ms: Mutex<Vec<f32>>,
    last: Mutex<Option<Instant>>,
}

pub struct Snapshot {
    pub fps_captured: f32,
    pub fps_encoded: f32,
    pub bitrate_kbps: u32,
    pub encode_ms_p50: f32,
    pub encode_ms_p99: f32,
    pub dropped: u32,
}

impl Collector {
    pub fn attach(
        self: &std::sync::Arc<Self>,
        capture: &gst::Pad,
        enc_sink: &gst::Pad,
        enc_src: &gst::Pad,
    ) {
        let c = self.clone();
        capture.add_probe(gst::PadProbeType::BUFFER, move |_, _| {
            c.captured.fetch_add(1, Ordering::Relaxed);
            gst::PadProbeReturn::Ok
        });
        let c = self.clone();
        enc_sink.add_probe(gst::PadProbeType::BUFFER, move |_, _| {
            c.entered.fetch_add(1, Ordering::Relaxed);
            let mut q = c.in_flight.lock().unwrap();
            if q.len() >= 32 {
                q.clear(); // the encoder dropped frames; resynchronize
            }
            q.push_back(Instant::now());
            gst::PadProbeReturn::Ok
        });
        let c = self.clone();
        enc_src.add_probe(gst::PadProbeType::BUFFER, move |_, info| {
            let Some(buf) = info.buffer() else {
                return gst::PadProbeReturn::Ok;
            };
            c.encoded.fetch_add(1, Ordering::Relaxed);
            c.bytes.fetch_add(buf.size() as u64, Ordering::Relaxed);
            // Output pts carry the video encoder's 1000 h offset, so match in FIFO order
            // (no B-frames: one output per input, same order).
            if let Some(t) = c.in_flight.lock().unwrap().pop_front() {
                c.encode_ms
                    .lock()
                    .unwrap()
                    .push(t.elapsed().as_secs_f32() * 1000.0);
            }
            gst::PadProbeReturn::Ok
        });
    }

    /// Rates since the previous snapshot; resets the counters.
    pub fn snapshot(&self) -> Snapshot {
        let now = Instant::now();
        let secs = self
            .last
            .lock()
            .unwrap()
            .replace(now)
            .map(|t| now.duration_since(t).as_secs_f32())
            .unwrap_or(1.0)
            .max(0.001);
        let captured = self.captured.swap(0, Ordering::Relaxed);
        let entered = self.entered.swap(0, Ordering::Relaxed);
        let encoded = self.encoded.swap(0, Ordering::Relaxed);
        let bytes = self.bytes.swap(0, Ordering::Relaxed);
        let mut ms = std::mem::take(&mut *self.encode_ms.lock().unwrap());
        ms.sort_by(f32::total_cmp);
        let pct = |p: f32| {
            ms.get(((ms.len() as f32 - 1.0) * p).round() as usize)
                .copied()
                .unwrap_or(0.0)
        };
        Snapshot {
            fps_captured: captured as f32 / secs,
            fps_encoded: encoded as f32 / secs,
            bitrate_kbps: (bytes as f32 * 8.0 / 1000.0 / secs) as u32,
            encode_ms_p50: pct(0.5),
            encode_ms_p99: pct(0.99),
            dropped: captured.saturating_sub(entered),
        }
    }
}

/// Finds round-trip time (ms) and fraction lost in webrtcsink's nested `stats`.
pub fn transport_stats(stats: &gst::StructureRef) -> (Option<f32>, Option<f32>) {
    let mut rtt = None;
    let mut loss = None;
    walk(stats, &mut |name, value| match name {
        "round-trip-time" if rtt.is_none() => {
            rtt = value.get::<f64>().ok().map(|s| (s * 1000.0) as f32)
        }
        "fraction-lost" if loss.is_none() => loss = value.get::<f64>().ok().map(|f| f as f32),
        _ => {}
    });
    (rtt, loss)
}

fn walk(s: &gst::StructureRef, f: &mut impl FnMut(&str, &glib::SendValue)) {
    for (name, value) in s.iter() {
        if let Ok(inner) = value.get::<gst::Structure>() {
            walk(&inner, f);
        } else {
            f(name, value);
        }
    }
}
