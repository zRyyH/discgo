//! Source-picker thumbnails (PLAN 6.7), 320 px wide PNG data URLs. They are
//! grabbed with GDI instead of a WGC pipeline: d3d11screencapturesrc keeps memory
//! per WGC capture it creates (phase 1), and the picker would create one per window.

use std::time::Duration;

use anyhow::{Context, Result, bail};
use base64::Engine as _;
use gst::prelude::*;
use gstreamer as gst;
use gstreamer_app as gst_app;
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CAPTUREBLT, CreateCompatibleBitmap, CreateCompatibleDC,
    CreateDIBSection, DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, HALFTONE, HDC, HGDIOBJ,
    ReleaseDC, SRCCOPY, SelectObject, SetStretchBltMode, StretchBlt,
};
use windows::Win32::Storage::Xps::{PRINT_WINDOW_FLAGS, PrintWindow};

const WIDTH: i32 = 320;
const MAX_HEIGHT: i32 = 200;
// Renders DirectComposition/hardware-accelerated content too (Windows 8.1+).
const PW_RENDERFULLCONTENT: u32 = 2;

pub fn monitor(x: i32, y: i32, w: i32, h: i32) -> Option<String> {
    grab(w, h, |dest, tw, th| unsafe {
        let screen = GetDC(None);
        let ok = StretchBlt(dest, 0, 0, tw, th, Some(screen), x, y, w, h, SRCCOPY | CAPTUREBLT).as_bool();
        ReleaseDC(None, screen);
        ok
    })
    .map_err(|e| log::debug!("monitor thumbnail: {e:#}"))
    .ok()
}

pub fn window(hwnd: HWND) -> Option<String> {
    let mut r = RECT::default();
    unsafe {
        DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &mut r as *mut _ as *mut _, size_of::<RECT>() as u32).ok()?;
    }
    let (w, h) = (r.right - r.left, r.bottom - r.top);
    grab(w, h, |dest, tw, th| unsafe {
        // Render the whole window into an offscreen bitmap, then scale it down.
        let screen = GetDC(None);
        let mem = CreateCompatibleDC(Some(screen));
        let bmp = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(mem, HGDIOBJ(bmp.0));
        let ok = PrintWindow(hwnd, mem, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT)).as_bool()
            && StretchBlt(dest, 0, 0, tw, th, Some(mem), 0, 0, w, h, SRCCOPY).as_bool();
        SelectObject(mem, old);
        let _ = DeleteObject(HGDIOBJ(bmp.0));
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
        ok
    })
    .map_err(|e| log::debug!("window thumbnail: {e:#}"))
    .ok()
}

/// Scales a w×h source into a WIDTH-wide BGRx buffer via `draw` and encodes it.
fn grab(w: i32, h: i32, draw: impl FnOnce(HDC, i32, i32) -> bool) -> Result<String> {
    if w <= 0 || h <= 0 {
        bail!("empty source");
    }
    let tw = WIDTH;
    let th = ((h as i64 * WIDTH as i64 / w as i64) as i32).clamp(2, MAX_HEIGHT) & !1;
    let pixels = unsafe {
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: tw,
                biHeight: -th, // top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let dc = CreateCompatibleDC(None);
        let mut bits = std::ptr::null_mut();
        let dib = CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0)?;
        let old = SelectObject(dc, HGDIOBJ(dib.0));
        SetStretchBltMode(dc, HALFTONE);
        let ok = draw(dc, tw, th);
        let pixels = std::slice::from_raw_parts(bits as *const u8, (tw * th * 4) as usize).to_vec();
        SelectObject(dc, old);
        let _ = DeleteObject(HGDIOBJ(dib.0));
        let _ = DeleteDC(dc);
        if !ok {
            bail!("GDI capture failed");
        }
        pixels
    };
    let png = encode_png(pixels, tw, th)?;
    Ok(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png)))
}

fn encode_png(bgrx: Vec<u8>, w: i32, h: i32) -> Result<Vec<u8>> {
    let pipeline = gst::parse::launch(&format!(
        "appsrc name=src caps=video/x-raw,format=BGRx,width={w},height={h},framerate=0/1 \
         ! videoconvert ! pngenc compression-level=3 ! appsink name=sink"
    ))?
    .downcast::<gst::Bin>()
    .unwrap();
    let src = pipeline.by_name("src").unwrap().downcast::<gst_app::AppSrc>().unwrap();
    let sink = pipeline.by_name("sink").unwrap().downcast::<gst_app::AppSink>().unwrap();
    pipeline.set_state(gst::State::Playing)?;
    src.push_buffer(gst::Buffer::from_mut_slice(bgrx))?;
    src.end_of_stream()?;
    let sample = sink.try_pull_sample(gst::ClockTime::from_mseconds(Duration::from_secs(2).as_millis() as u64));
    let _ = pipeline.set_state(gst::State::Null);
    let buffer = sample.context("png encoder timed out")?.buffer_owned().context("no buffer")?;
    let map = buffer.map_readable()?;
    Ok(map.as_slice().to_vec())
}
