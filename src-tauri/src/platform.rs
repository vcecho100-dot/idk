//! Small OS queries: Windows build number and GPU adapters (for the VRAM-aware local profile).

use serde::Serialize;

/// Returns (major, minor, build) — reliable even without a compatibility manifest.
#[cfg(windows)]
pub fn windows_version() -> (u32, u32, u32) {
    use windows::Wdk::System::SystemServices::RtlGetVersion;
    use windows::Win32::System::SystemInformation::OSVERSIONINFOW;
    let mut info = OSVERSIONINFOW {
        dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
        ..Default::default()
    };
    // SAFETY: `info` is a properly sized, initialised OSVERSIONINFOW.
    let status = unsafe { RtlGetVersion(&mut info) };
    if status.is_ok() {
        (info.dwMajorVersion, info.dwMinorVersion, info.dwBuildNumber)
    } else {
        (0, 0, 0)
    }
}

#[cfg(not(windows))]
pub fn windows_version() -> (u32, u32, u32) {
    (0, 0, 0)
}

/// Mica requires Windows 11 (build 22000+).
pub fn supports_mica() -> bool {
    cfg!(windows) && windows_version().2 >= 22000
}

pub fn os_label() -> String {
    let (major, minor, build) = windows_version();
    if cfg!(windows) {
        let name = if build >= 22000 { "Windows 11" } else { "Windows 10" };
        format!("{name} ({major}.{minor}.{build})")
    } else {
        std::env::consts::OS.to_string()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub name: String,
    pub vram_mb: u64,
    pub vendor: String,
}

/// Lists hardware GPUs with their dedicated VRAM via DXGI (WMI caps VRAM at 4 GB).
#[cfg(windows)]
pub fn gpus() -> Vec<GpuInfo> {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE};

    let mut out = Vec::new();
    // SAFETY: standard DXGI enumeration; all COM objects are released on drop.
    unsafe {
        let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() else {
            return out;
        };
        let mut i = 0;
        while let Ok(adapter) = factory.EnumAdapters1(i) {
            i += 1;
            let Ok(desc) = adapter.GetDesc1() else { continue };
            if (desc.Flags as i32 & DXGI_ADAPTER_FLAG_SOFTWARE.0) != 0 {
                continue;
            }
            let len = desc.Description.iter().position(|&c| c == 0).unwrap_or(desc.Description.len());
            let name = String::from_utf16_lossy(&desc.Description[..len]);
            let vendor = match desc.VendorId {
                0x10DE => "NVIDIA",
                0x1002 | 0x1022 => "AMD",
                0x8086 => "Intel",
                0x5143 => "Qualcomm",
                _ => "Other",
            }
            .to_string();
            out.push(GpuInfo { name, vram_mb: (desc.DedicatedVideoMemory / (1024 * 1024)) as u64, vendor });
        }
    }
    out.sort_by_key(|g| std::cmp::Reverse(g.vram_mb));
    out
}

#[cfg(not(windows))]
pub fn gpus() -> Vec<GpuInfo> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_sane_on_windows() {
        if cfg!(windows) {
            let (major, _, build) = windows_version();
            assert!(major >= 10);
            assert!(build > 0);
        }
    }

    #[test]
    fn gpu_enumeration_does_not_panic() {
        let list = gpus();
        for g in list {
            assert!(!g.name.is_empty());
        }
    }
}
