//! Window lifecycle: splash → main handoff, appearance (Mica), second-instance forwarding.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

use crate::error::AppResult;

/// Keeps the splash visible long enough to avoid a jarring flash on fast machines.
const MIN_SPLASH: Duration = Duration::from_millis(450);
/// If the UI never reports ready (e.g. a crash during boot), show the window anyway.
const SPLASH_FALLBACK: Duration = Duration::from_secs(12);

pub struct Startup {
    started: Instant,
    shown: AtomicBool,
    /// Files passed at launch (file associations), delivered once the UI is listening.
    pending: Mutex<Vec<PathBuf>>,
}

impl Startup {
    pub fn new() -> Self {
        Self { started: Instant::now(), shown: AtomicBool::new(false), pending: Mutex::new(Vec::new()) }
    }
}

pub fn queue_launch_paths<R: Runtime>(app: &AppHandle<R>, paths: Vec<PathBuf>) {
    app.state::<Startup>().pending.lock().expect("startup lock").extend(paths);
}

fn deliver(app: &AppHandle<impl Runtime>, paths: Vec<PathBuf>) {
    if paths.is_empty() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let items = crate::files::classify(&app.state::<crate::state::AppState>(), &paths);
        crate::files::emit_dropped(&app, items);
    });
}

pub fn reveal_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
}

fn finish_startup<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<Startup>();
    if state.shown.swap(true, Ordering::SeqCst) {
        return;
    }
    reveal_main(app);
    if let Some(splash) = app.get_webview_window("splash") {
        let _ = splash.destroy();
    }
}

pub fn arm_splash_fallback<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SPLASH_FALLBACK).await;
        finish_startup(&app);
    });
}

/// Called by the UI once fonts, theme and the first screen have rendered
/// (or with `boot_error` if the UI failed to start, so the window still appears).
#[tauri::command]
pub async fn app_ready<R: Runtime>(app: AppHandle<R>, boot_error: Option<String>) -> AppResult<()> {
    let elapsed = app.state::<Startup>().started.elapsed();
    if let Some(err) = &boot_error {
        log::error!("UI failed to start: {err}");
    }
    #[cfg(debug_assertions)]
    eprintln!("[shift3d] UI ready in {} ms{}", elapsed.as_millis(), boot_error.map(|e| format!(" — BOOT ERROR: {e}")).unwrap_or_default());
    if elapsed < MIN_SPLASH {
        tokio::time::sleep(MIN_SPLASH - elapsed).await;
    }
    finish_startup(&app);
    let pending = std::mem::take(&mut *app.state::<Startup>().pending.lock().expect("startup lock"));
    deliver(&app, pending);
    Ok(())
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeChoice {
    Dark,
    Light,
}

/// Matches the native window (Mica tint, system theme) to the app theme.
/// Returns whether the translucent Mica backdrop is active, so the UI only
/// makes its surfaces see-through when there is something behind them.
#[tauri::command]
pub fn set_window_appearance<R: Runtime>(
    window: WebviewWindow<R>,
    theme: ThemeChoice,
    translucent: bool,
) -> AppResult<bool> {
    let native = match theme {
        ThemeChoice::Dark => tauri::Theme::Dark,
        ThemeChoice::Light => tauri::Theme::Light,
    };
    window.set_theme(Some(native))?;

    #[cfg(target_os = "windows")]
    {
        use tauri::window::{Effect, EffectsBuilder};
        if translucent && crate::platform::supports_mica() {
            let effect = match theme {
                ThemeChoice::Dark => Effect::MicaDark,
                ThemeChoice::Light => Effect::MicaLight,
            };
            window.set_effects(EffectsBuilder::new().effect(effect).build())?;
            return Ok(true);
        }
        window.set_effects(None)?;
    }
    #[cfg(not(target_os = "windows"))]
    let _ = translucent;
    Ok(false)
}

/// Forwards files from a second launch (file association / "Open with") to the UI.
/// They're granted (the user chose them in Explorer) and classified like a drop.
pub fn forward_launch_args<R: Runtime>(app: &AppHandle<R>, argv: Vec<String>) {
    let paths: Vec<PathBuf> = argv.into_iter().skip(1).filter(|a| !a.starts_with('-')).map(PathBuf::from).collect();
    deliver(app, paths);
}
