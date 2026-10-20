//! Non-secret preferences, stored as JSON in the app data dir. API keys never live here.

use std::path::{Path, PathBuf};
use std::sync::RwLock;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::{AppError, AppResult, ErrorCode};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub theme: String,
    pub accent: String,
    pub mica: bool,
    pub reduced_motion: bool,
    pub onboarding_done: bool,
    pub tour_done: bool,
    pub default_provider: String,
    pub auto_web_fallback: bool,
    pub output_dir: String,
    pub default_export_format: String,
    pub default_engine_preset: String,
    pub godot_project_path: Option<String>,
    pub blender_path: Option<String>,
    pub viewport_quality: String,
    pub fps_cap: u32,
    pub update_channel: String,
    pub auto_check_updates: bool,
    pub notifications: bool,
    pub local_server_url: String,
    pub local_server_kind: String,
    /// The user's api_server was started with `--enable_tex` (needs ~16 GB VRAM).
    pub local_texture: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "dark".into(),
            accent: "aurora".into(),
            mica: true,
            reduced_motion: false,
            onboarding_done: false,
            tour_done: false,
            default_provider: "mock".into(),
            auto_web_fallback: true,
            output_dir: String::new(),
            default_export_format: "glb".into(),
            default_engine_preset: "none".into(),
            godot_project_path: None,
            blender_path: None,
            viewport_quality: "high".into(),
            fps_cap: 60,
            update_channel: "stable".into(),
            auto_check_updates: true,
            notifications: true,
            local_server_url: "http://127.0.0.1:8081".into(),
            local_server_kind: "hunyuan3d".into(),
            local_texture: false,
        }
    }
}

const THEMES: &[&str] = &["dark", "light"];
const ACCENTS: &[&str] = &["aurora", "sunset", "lagoon", "orchid", "ocean", "ember"];
const PROVIDERS: &[&str] = &["mock", "tripo", "meshy", "fal", "local", "hfspace"];
const FORMATS: &[&str] = &["glb", "gltf", "obj", "stl", "usdz"];
const PRESETS: &[&str] = &["none", "godot", "unity", "unreal", "blender", "print"];
const QUALITIES: &[&str] = &["low", "medium", "high", "ultra"];
const CHANNELS: &[&str] = &["stable", "beta"];
const LOCAL_KINDS: &[&str] = &["hunyuan3d", "hunyuan3d-gradio", "trellis"];
const FPS: &[u32] = &[30, 60, 120, 0];

/// Keys the webview may change. Paths that grant file-system reach (output folder,
/// Godot project, Blender executable) are only set through native pickers in Rust.
const WEB_WRITABLE: &[&str] = &[
    "theme",
    "accent",
    "mica",
    "reducedMotion",
    "onboardingDone",
    "tourDone",
    "defaultProvider",
    "autoWebFallback",
    "defaultExportFormat",
    "defaultEnginePreset",
    "viewportQuality",
    "fpsCap",
    "updateChannel",
    "autoCheckUpdates",
    "notifications",
    "localServerUrl",
    "localServerKind",
    "localTexture",
];
/// Path settings the webview may *clear* (set to null) but never set.
const WEB_CLEARABLE: &[&str] = &["godotProjectPath", "blenderPath"];

impl Settings {
    pub fn validate(&self) -> AppResult<()> {
        let check = |ok: bool, what: &str| {
            if ok {
                Ok(())
            } else {
                Err(AppError::new(ErrorCode::Validation, format!("Invalid setting: {what}.")))
            }
        };
        check(THEMES.contains(&self.theme.as_str()), "theme")?;
        check(ACCENTS.contains(&self.accent.as_str()), "accent")?;
        check(PROVIDERS.contains(&self.default_provider.as_str()), "default provider")?;
        check(FORMATS.contains(&self.default_export_format.as_str()), "export format")?;
        check(PRESETS.contains(&self.default_engine_preset.as_str()), "engine preset")?;
        check(QUALITIES.contains(&self.viewport_quality.as_str()), "viewport quality")?;
        check(CHANNELS.contains(&self.update_channel.as_str()), "update channel")?;
        check(LOCAL_KINDS.contains(&self.local_server_kind.as_str()), "local server type")?;
        check(FPS.contains(&self.fps_cap), "FPS cap")?;
        validate_local_url(&self.local_server_url)?;
        Ok(())
    }

    /// Merges a patch coming from the webview, enforcing the writable-key allowlist.
    pub fn apply_web_patch(&self, patch: &Map<String, Value>) -> AppResult<Settings> {
        let mut current = serde_json::to_value(self)?;
        let obj = current.as_object_mut().expect("settings serialize to an object");
        for (key, value) in patch {
            if WEB_WRITABLE.contains(&key.as_str()) {
                obj.insert(key.clone(), value.clone());
            } else if WEB_CLEARABLE.contains(&key.as_str()) && value.is_null() {
                obj.insert(key.clone(), Value::Null);
            } else {
                return Err(AppError::new(ErrorCode::Validation, format!("The setting “{key}” can't be changed from here."))
                    .with_hint("Use the Browse… button next to it."));
            }
        }
        let next: Settings = serde_json::from_value(current)
            .map_err(|e| AppError::new(ErrorCode::Validation, format!("Invalid setting value: {e}")))?;
        next.validate()?;
        Ok(next)
    }
}

/// The local server must be an http(s) URL without credentials or query/fragment.
pub fn validate_local_url(raw: &str) -> AppResult<url::Url> {
    let bad = || {
        AppError::new(ErrorCode::Validation, "The local server URL isn't valid.")
            .with_hint("Use something like http://127.0.0.1:8081 (the address your Hunyuan3D or TRELLIS server prints).")
    };
    let url = url::Url::parse(raw.trim()).map_err(|_| bad())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err(bad());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(bad());
    }
    Ok(url)
}

pub struct SettingsStore {
    path: PathBuf,
    current: RwLock<Settings>,
}

impl SettingsStore {
    pub fn load(path: &Path, default_output: &Path) -> Self {
        let mut settings = std::fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Settings>(&bytes).ok())
            .filter(|s| s.validate().is_ok())
            .unwrap_or_default();
        if settings.output_dir.is_empty() || !Path::new(&settings.output_dir).is_dir() {
            settings.output_dir = default_output.to_string_lossy().into_owned();
        }
        Self { path: path.to_path_buf(), current: RwLock::new(settings) }
    }

    pub fn get(&self) -> Settings {
        self.current.read().expect("settings lock").clone()
    }

    pub fn set(&self, next: Settings) -> AppResult<Settings> {
        next.validate()?;
        write_atomic(&self.path, &serde_json::to_vec_pretty(&next)?)?;
        *self.current.write().expect("settings lock") = next.clone();
        Ok(next)
    }

    pub fn update(&self, f: impl FnOnce(&mut Settings)) -> AppResult<Settings> {
        let mut next = self.get();
        f(&mut next);
        self.set(next)
    }
}

/// Writes via a temp file + rename so a crash never leaves a half-written file.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn patch(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn defaults_are_valid() {
        Settings::default().validate().unwrap();
    }

    #[test]
    fn web_patch_updates_allowed_keys() {
        let s = Settings::default();
        let next = s.apply_web_patch(&patch(json!({ "theme": "light", "fpsCap": 120 }))).unwrap();
        assert_eq!(next.theme, "light");
        assert_eq!(next.fps_cap, 120);
    }

    #[test]
    fn web_patch_rejects_paths_and_bad_values() {
        let s = Settings::default();
        assert!(s.apply_web_patch(&patch(json!({ "blenderPath": "C:\\evil.exe" }))).is_err());
        assert!(s.apply_web_patch(&patch(json!({ "outputDir": "C:\\Windows" }))).is_err());
        assert!(s.apply_web_patch(&patch(json!({ "theme": "neon" }))).is_err());
        assert!(s.apply_web_patch(&patch(json!({ "fpsCap": 7 }))).is_err());
        assert!(s.apply_web_patch(&patch(json!({ "localServerUrl": "file:///C:/x" }))).is_err());
        // Clearing a path is allowed.
        let mut with = s.clone();
        with.blender_path = Some("C:\\Blender\\blender.exe".into());
        let cleared = with.apply_web_patch(&patch(json!({ "blenderPath": null }))).unwrap();
        assert_eq!(cleared.blender_path, None);
    }

    #[test]
    fn local_url_validation() {
        assert!(validate_local_url("http://127.0.0.1:8081").is_ok());
        assert!(validate_local_url("http://192.168.1.20:7860/").is_ok());
        assert!(validate_local_url("ftp://x").is_err());
        assert!(validate_local_url("http://user:pw@host").is_err());
        assert!(validate_local_url("not a url").is_err());
    }
}
