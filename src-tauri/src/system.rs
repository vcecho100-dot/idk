//! Settings, providers, system info, updates, external links and data reset.

use std::sync::Mutex;

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;
use url::Url;

use crate::error::{AppError, AppResult, ErrorCode};
use crate::platform::{self, GpuInfo};
use crate::providers::{self, local::LocalServerProbe, Capabilities, ConnectionTest, Ctx, ImageInput};
use crate::secrets;
use crate::settings::{validate_local_url, Settings};
use crate::state::AppState;

pub const REPO: &str = "vcecho100-dot/idk";

/* -------------------------------- Settings -------------------------------- */

#[tauri::command]
pub fn get_settings(st: State<'_, AppState>) -> Settings {
    st.settings.get()
}

#[tauri::command]
pub fn update_settings(st: State<'_, AppState>, patch: Map<String, Value>) -> AppResult<Settings> {
    let next = st.settings.get().apply_web_patch(&patch)?;
    let saved = st.settings.set(next)?;
    if let Ok(url) = validate_local_url(&saved.local_server_url) {
        st.net.set_local_server(&url);
    }
    Ok(saved)
}

/* ---------------------------------- System ---------------------------------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    app_version: &'static str,
    os: String,
    gpus: Vec<GpuInfo>,
    data_dir: String,
    library_dir: String,
    online: bool,
}

#[tauri::command]
pub async fn system_info(st: State<'_, AppState>) -> AppResult<SystemInfo> {
    let gpus = tauri::async_runtime::spawn_blocking(platform::gpus).await.unwrap_or_default();
    Ok(SystemInfo {
        app_version: env!("CARGO_PKG_VERSION"),
        os: platform::os_label(),
        gpus,
        data_dir: st.paths.data_dir.to_string_lossy().into_owned(),
        library_dir: st.paths.library_dir.to_string_lossy().into_owned(),
        online: true,
    })
}

/// External links are limited to https URLs on a known set of hosts.
const LINK_HOSTS: &[&str] = &[
    "github.com",
    "platform.tripo3d.ai",
    "developers.tripo3d.ai",
    "www.meshy.ai",
    "docs.meshy.ai",
    "fal.ai",
    "huggingface.co",
    "www.blender.org",
    "godotengine.org",
];

#[tauri::command]
pub fn open_external<R: Runtime>(app: AppHandle<R>, url: String) -> AppResult<()> {
    let parsed = Url::parse(&url).map_err(|_| AppError::new(ErrorCode::Validation, "Invalid link."))?;
    if parsed.scheme() != "https" || !parsed.host_str().is_some_and(|h| LINK_HOSTS.contains(&h)) {
        return Err(AppError::new(ErrorCode::Validation, "Shift3D only opens links to trusted sites."));
    }
    app.opener().open_url(parsed.as_str(), None::<&str>).map_err(|e| AppError::new(ErrorCode::Io, format!("Couldn't open the browser: {e}")))
}

/// Clears settings, keys, the library index and staging. Model files in
/// Documents/Shift3D are left in place (they're the user's).
#[tauri::command]
pub fn reset_app_data<R: Runtime>(app: AppHandle<R>, st: State<'_, AppState>) -> AppResult<()> {
    for job in st.db.jobs()? {
        st.jobs.cancel_token(&job.job.id);
    }
    st.db.reset()?;
    secrets::clear_all();
    let _ = std::fs::remove_dir_all(&st.paths.staging_dir);
    std::fs::create_dir_all(&st.paths.staging_dir)?;
    st.settings.set(Settings { output_dir: st.paths.exports_dir.to_string_lossy().into_owned(), ..Default::default() })?;
    crate::library::emit(&app, crate::library::LibraryEvent::Reset);
    Ok(())
}

/* -------------------------------- Providers -------------------------------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    requires_key: bool,
    configured: bool,
    available: bool,
    unavailable_reason: Option<String>,
    free: bool,
    capabilities: Capabilities,
    dashboard_url: Option<&'static str>,
    docs_url: Option<&'static str>,
}

#[tauri::command]
pub fn list_providers(st: State<'_, AppState>) -> Vec<ProviderInfo> {
    let settings = st.settings.get();
    providers::ALL
        .iter()
        .filter_map(|id| providers::get(id).ok())
        .map(|p| {
            let m = p.meta();
            let has_key = secrets::has(m.id);
            let (available, reason) = if m.requires_key && !has_key {
                (false, Some(format!("Add your {} API key in Settings → Providers.", m.name)))
            } else if m.id == "local" && validate_local_url(&settings.local_server_url).is_err() {
                (false, Some("Set your local server address in Settings → Providers.".to_string()))
            } else {
                (true, None)
            };
            ProviderInfo {
                id: m.id,
                name: m.name,
                description: m.description,
                requires_key: m.requires_key,
                configured: if m.requires_key { has_key } else { true },
                available,
                unavailable_reason: reason,
                free: m.free,
                capabilities: p.capabilities(&settings),
                dashboard_url: m.dashboard_url,
                docs_url: m.docs_url,
            }
        })
        .collect()
}

#[tauri::command]
pub fn set_provider_key(provider: String, key: String) -> AppResult<()> {
    secrets::set(&provider, &key)
}

#[tauri::command]
pub fn clear_provider_key(provider: String) -> AppResult<()> {
    secrets::clear(&provider)
}

#[tauri::command]
pub async fn test_provider(st: State<'_, AppState>, provider: String) -> AppResult<ConnectionTest> {
    let p = providers::get(&provider)?;
    let stage = |_: &str, _: &[u8]| -> AppResult<String> { Err(AppError::internal("unused")) };
    let read = |_: &str| -> AppResult<ImageInput> { Err(AppError::internal("unused")) };
    let ctx = Ctx {
        net: &st.net,
        key: if secrets::KEYED_PROVIDERS.contains(&provider.as_str()) { secrets::get(&provider)? } else { None },
        settings: st.settings.get(),
        cancel: tokio_util::sync::CancellationToken::new(),
        stage_image: &stage,
        read_staged: &read,
    };
    p.test_connection(&ctx).await
}

#[tauri::command]
pub fn provider_usage(st: State<'_, AppState>) -> AppResult<Vec<crate::db::ProviderUsage>> {
    st.db.usage()
}

#[tauri::command]
pub async fn probe_local_server(st: State<'_, AppState>, url: String) -> AppResult<LocalServerProbe> {
    let parsed = validate_local_url(&url)?;
    // Probing only reaches the address the user typed.
    st.net.set_local_server(&parsed);
    let result = providers::local::probe(&st.net, &parsed).await;
    if let Ok(current) = validate_local_url(&st.settings.get().local_server_url) {
        st.net.set_local_server(&current);
    }
    Ok(result)
}

/* --------------------------------- Updates --------------------------------- */

#[derive(Default)]
pub struct PendingUpdate(pub Mutex<Option<tauri_plugin_updater::Update>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    available: bool,
    version: Option<String>,
    notes: Option<String>,
    date: Option<String>,
}

fn endpoint(channel: &str) -> Url {
    let url = if channel == "beta" {
        format!("https://github.com/{REPO}/releases/download/beta-channel/latest.json")
    } else {
        format!("https://github.com/{REPO}/releases/latest/download/latest.json")
    };
    Url::parse(&url).expect("static URL")
}

#[tauri::command]
pub async fn check_for_updates<R: Runtime>(app: AppHandle<R>, channel: String) -> AppResult<UpdateInfo> {
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint(&channel)])
        .map_err(|e| AppError::internal(e.to_string()))?
        .build()
        .map_err(|e| AppError::internal(e.to_string()))?;
    let found = updater.check().await.map_err(|e| {
        let msg = e.to_string();
        if msg.contains("404") || msg.to_lowercase().contains("not found") {
            AppError::new(ErrorCode::NotFound, "No releases have been published yet.").with_hint("You're on the latest build.")
        } else {
            AppError::new(ErrorCode::Network, "Couldn't check for updates.").with_hint("Check your internet connection and try again.")
        }
    })?;
    let info = UpdateInfo {
        available: found.is_some(),
        version: found.as_ref().map(|u| u.version.clone()),
        notes: found.as_ref().and_then(|u| u.body.clone()),
        date: found.as_ref().and_then(|u| u.date.map(|d| d.to_string())),
    };
    *app.state::<PendingUpdate>().0.lock().expect("update lock") = found;
    Ok(info)
}

#[tauri::command]
pub async fn install_update<R: Runtime>(app: AppHandle<R>) -> AppResult<()> {
    let update = app
        .state::<PendingUpdate>()
        .0
        .lock()
        .expect("update lock")
        .take()
        .ok_or_else(|| AppError::new(ErrorCode::Validation, "No update is ready.").with_hint("Check for updates first."))?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| AppError::new(ErrorCode::Network, format!("The update couldn't be installed: {e}")).with_hint("Try again, or download the installer from GitHub Releases."))?;
    app.restart();
}
