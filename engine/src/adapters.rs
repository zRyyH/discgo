//! DXGI adapter enumeration: maps encoder LUIDs to GPUs and fingerprints the
//! installed drivers for the probe cache.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE, IDXGIDevice, IDXGIFactory1,
};
use windows::core::Interface;

use crate::protocol::AdapterInfo;

/// Stable across reboots (LUIDs are not); compared in DXGI enumeration order.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AdapterSignature {
    pub vendor_id: u32,
    pub device_id: u32,
    pub driver_version: i64,
}

pub struct Adapter {
    pub info: AdapterInfo,
    pub signature: AdapterSignature,
}

pub fn enumerate() -> Result<Vec<Adapter>> {
    let mut out = Vec::new();
    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1()?;
        let mut index = 0;
        while let Ok(adapter) = factory.EnumAdapters1(index) {
            let desc = adapter.GetDesc1()?;
            index += 1;
            if desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 {
                continue;
            }
            let luid = ((desc.AdapterLuid.HighPart as i64) << 32) | desc.AdapterLuid.LowPart as i64;
            let len = desc
                .Description
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(desc.Description.len());
            let driver_version = adapter
                .CheckInterfaceSupport(&IDXGIDevice::IID)
                .unwrap_or(0);
            out.push(Adapter {
                info: AdapterInfo {
                    index: index - 1,
                    luid,
                    description: String::from_utf16_lossy(&desc.Description[..len]),
                    vendor_id: desc.VendorId,
                    device_id: desc.DeviceId,
                },
                signature: AdapterSignature {
                    vendor_id: desc.VendorId,
                    device_id: desc.DeviceId,
                    driver_version,
                },
            });
        }
    }
    Ok(out)
}
