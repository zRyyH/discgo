//! Encoder detection (PLAN 6.2): find candidate factories, run a short test
//! pipeline per candidate, cache the result keyed by GPU/driver signature.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use gstreamer as gst;
use gstreamer::prelude::*;
use serde::{Deserialize, Serialize};

use crate::adapters;
use crate::protocol::{AdapterInfo, Codec, EncoderInfo, Vendor};

const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const CACHE_VERSION: u32 = 1;

/// (factory name prefix, vendor, codec). Per-adapter variants are registered as
/// e.g. "nvd3d11h264device1enc", so matching is by prefix + "enc" suffix.
const HW_CANDIDATES: &[(&str, Vendor, Codec)] = &[
    ("nvd3d11h264", Vendor::Nvidia, Codec::H264),
    ("nvd3d11av1", Vendor::Nvidia, Codec::Av1),
    ("amfh264", Vendor::Amd, Codec::H264),
    ("amfav1", Vendor::Amd, Codec::Av1),
    ("qsvh264", Vendor::Intel, Codec::H264),
    ("qsvav1", Vendor::Intel, Codec::Av1),
    ("mfh264", Vendor::Microsoft, Codec::H264),
    ("mfav1", Vendor::Microsoft, Codec::Av1),
];

#[derive(Serialize, Deserialize, PartialEq)]
struct Signature {
    cache_version: u32,
    engine_version: String,
    gst_version: String,
    adapters: Vec<adapters::AdapterSignature>,
}

#[derive(Serialize, Deserialize)]
struct Cache {
    signature: Signature,
    encoders: Vec<EncoderInfo>,
}

pub struct ProbeResult {
    pub encoders: Vec<EncoderInfo>,
    pub warnings: Vec<String>,
}

pub fn probe(force: bool) -> ProbeResult {
    let mut warnings = Vec::new();
    let adapter_list = adapters::enumerate().unwrap_or_else(|e| {
        warnings.push(format!("dxgi adapter enumeration failed: {e:#}"));
        Vec::new()
    });
    let signature = Signature {
        cache_version: CACHE_VERSION,
        engine_version: env!("CARGO_PKG_VERSION").to_owned(),
        gst_version: gst::version_string().to_string(),
        adapters: adapter_list.iter().map(|a| a.signature.clone()).collect(),
    };

    let infos: Vec<AdapterInfo> = adapter_list.into_iter().map(|a| a.info).collect();

    if !force && let Some(mut cache) = read_cache().filter(|c| c.signature == signature) {
        log::info!(
            "encoder probe: using cache ({} encoders)",
            cache.encoders.len()
        );
        // Same GPUs in the same order, but LUIDs change on every boot.
        for e in &mut cache.encoders {
            if let Some(a) = &e.adapter {
                e.adapter = infos.iter().find(|i| i.index == a.index).cloned();
            }
        }
        return ProbeResult {
            encoders: cache.encoders,
            warnings,
        };
    }
    let mut encoders = Vec::new();
    for (factory, vendor, codec) in candidate_factories() {
        let name = factory.name().to_string();
        let adapter = adapter_of(&factory, &infos);
        let d3d11 = accepts_d3d11(&factory);
        // Media Foundation also registers software MFTs; the vendor SDK encoders are always hardware.
        let hardware = match vendor {
            Vendor::Nvidia | Vendor::Amd | Vendor::Intel => true,
            Vendor::Microsoft => factory.klass().contains("Hardware"),
            Vendor::Software => false,
        };
        if vendor == Vendor::Microsoft && !hardware {
            continue; // software MFT: x264enc is the software fallback
        }
        let started = std::time::Instant::now();
        // Hardware sessions are released asynchronously after the previous
        // candidate (e.g. the NVIDIA MFT wraps NVENC), so retry once.
        let result = test_encode(&name, adapter.as_ref(), d3d11).or_else(|e| {
            if !hardware {
                return Err(e);
            }
            log::debug!("encoder probe: {name} retrying after: {e:#}");
            std::thread::sleep(Duration::from_millis(250));
            test_encode(&name, adapter.as_ref(), d3d11)
        });
        match result {
            Ok(()) => {
                log::info!("encoder probe: {name} ok in {:?}", started.elapsed());
                encoders.push(EncoderInfo {
                    hardware,
                    name,
                    vendor,
                    codec,
                    d3d11,
                    adapter,
                });
            }
            Err(e) => {
                log::warn!("encoder probe: {name} failed: {e:#}");
                warnings.push(format!("{name}: {e:#}"));
            }
        }
    }
    encoders.sort_by_key(|e| (!e.hardware, rank(&e.vendor), e.codec != Codec::H264));

    // A failure may be transient; only a clean probe is worth reusing.
    if warnings.is_empty()
        && let Err(e) = write_cache(&Cache {
            signature,
            encoders: encoders.clone(),
        })
    {
        log::warn!("encoder probe: cache write failed: {e:#}");
    }
    ProbeResult { encoders, warnings }
}

fn rank(v: &Vendor) -> u8 {
    match v {
        Vendor::Nvidia => 0,
        Vendor::Amd => 1,
        Vendor::Intel => 2,
        Vendor::Microsoft => 3,
        Vendor::Software => 4,
    }
}

fn candidate_factories() -> Vec<(gst::ElementFactory, Vendor, Codec)> {
    let mut out = Vec::new();
    let registry = gst::Registry::get();
    for feature in registry.features(gst::ElementFactory::static_type()) {
        let Ok(factory) = feature.downcast::<gst::ElementFactory>() else {
            continue;
        };
        let name = factory.name();
        if name == "x264enc" {
            out.push((factory, Vendor::Software, Codec::H264));
            continue;
        }
        if !name.ends_with("enc") {
            continue;
        }
        if let Some((_, vendor, codec)) = HW_CANDIDATES.iter().find(|(prefix, _, _)| {
            name.strip_prefix(prefix)
                .and_then(|rest| rest.strip_suffix("enc"))
                .is_some_and(|mid| mid.is_empty() || mid.starts_with("device"))
        }) {
            out.push((factory, vendor.clone(), codec.clone()));
        }
    }
    // Vendor SDK encoders first, so they are not starved by an MFT wrapping the same hardware.
    out.sort_by_key(|(f, vendor, _)| (rank(vendor), f.name()));
    out
}

/// Hardware encoders expose their DXGI adapter as a read-only "adapter-luid".
fn adapter_of(factory: &gst::ElementFactory, adapters: &[AdapterInfo]) -> Option<AdapterInfo> {
    let element = factory.create().build().ok()?;
    element.find_property("adapter-luid")?;
    let luid = element.property_value("adapter-luid").get::<i64>().ok()?;
    adapters.iter().find(|a| a.luid == luid).cloned()
}

fn accepts_d3d11(factory: &gst::ElementFactory) -> bool {
    factory
        .static_pad_templates()
        .iter()
        .filter(|t| t.direction() == gst::PadDirection::Sink)
        .any(|t| {
            t.caps()
                .iter_with_features()
                .any(|(_, f)| f.contains("memory:D3D11Memory"))
        })
}

fn test_encode(name: &str, adapter: Option<&AdapterInfo>, d3d11: bool) -> Result<()> {
    let desc = match (d3d11, adapter) {
        (true, Some(a)) => format!(
            "d3d11testsrc adapter={} num-buffers=3 \
             ! video/x-raw(memory:D3D11Memory),width=1280,height=720,framerate=30/1 \
             ! d3d11convert ! video/x-raw(memory:D3D11Memory),format=NV12 \
             ! {name} ! fakesink",
            a.index
        ),
        _ => format!(
            "videotestsrc num-buffers=3 \
             ! video/x-raw,format=NV12,width=1280,height=720,framerate=30/1 \
             ! {name} ! fakesink"
        ),
    };
    let pipeline = gst::parse::launch(&desc).context("build test pipeline")?;
    let result = run_to_eos(&pipeline);
    let _ = pipeline.set_state(gst::State::Null);
    result
}

fn run_to_eos(pipeline: &gst::Element) -> Result<()> {
    pipeline
        .set_state(gst::State::Playing)
        .context("set Playing")?;
    let bus = pipeline.bus().context("pipeline has no bus")?;
    match bus.timed_pop_filtered(
        gst::ClockTime::from_mseconds(PROBE_TIMEOUT.as_millis() as u64),
        &[gst::MessageType::Eos, gst::MessageType::Error],
    ) {
        None => bail!("timeout after {PROBE_TIMEOUT:?}"),
        Some(msg) => match msg.view() {
            gst::MessageView::Eos(_) => Ok(()),
            gst::MessageView::Error(err) => bail!("{} ({:?})", err.error(), err.debug()),
            _ => unreachable!(),
        },
    }
}

fn cache_path() -> Option<PathBuf> {
    Some(
        PathBuf::from(std::env::var_os("LOCALAPPDATA")?)
            .join("discgo")
            .join("engine-probe.json"),
    )
}

fn read_cache() -> Option<Cache> {
    let data = std::fs::read(cache_path()?).ok()?;
    serde_json::from_slice(&data).ok()
}

fn write_cache(cache: &Cache) -> Result<()> {
    let path = cache_path().context("LOCALAPPDATA not set")?;
    std::fs::create_dir_all(path.parent().unwrap())?;
    std::fs::write(&path, serde_json::to_vec_pretty(cache)?)?;
    Ok(())
}
