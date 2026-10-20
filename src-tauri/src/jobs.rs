//! The persistent job queue. Jobs live in SQLite, run concurrently in the
//! background, survive restarts (re-attaching to remote tasks where the provider
//! allows it), download results the moment they're ready, and notify the user.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::db::{now, Job, JobError, JobRecord};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::library::{self, NewVersionMeta, VersionExtra};
use crate::paths::safe_id;
use crate::providers::{self, CancelOutcome, Ctx, GenerateSpec, ImageInput, JobKind, JobSpec, ModelSource, RemoteState, SourceModel, TaskInput};
use crate::secrets;
use crate::state::{new_id, AppState};

const MAX_CONCURRENT: usize = 4;
const ACTIVE: &[&str] = &["queued", "running", "downloading"];

#[derive(Clone, Default)]
pub struct JobQueue {
    running: Arc<Mutex<HashMap<String, (CancellationToken, String)>>>,
    wake: Arc<Notify>,
}

impl JobQueue {
    pub fn kick(&self) {
        self.wake.notify_one();
    }

    fn is_running(&self, id: &str) -> bool {
        self.running.lock().expect("queue lock").contains_key(id)
    }

    pub fn cancel_token(&self, id: &str) -> bool {
        match self.running.lock().expect("queue lock").get(id) {
            Some((t, _)) => {
                t.cancel();
                true
            }
            None => false,
        }
    }

    pub fn cancel_project(&self, project_id: &str) {
        for (t, p) in self.running.lock().expect("queue lock").values() {
            if p == project_id {
                t.cancel();
            }
        }
    }

    /// Re-queues jobs interrupted by a restart, then starts the dispatcher.
    pub fn start<R: Runtime>(&self, app: AppHandle<R>) {
        let st = app.state::<AppState>();
        if let Ok(interrupted) = st.db.jobs_with_status(&["running", "downloading"]) {
            for mut rec in interrupted {
                let resumable = providers::get(&rec.job.provider).map(|p| p.resumable()).unwrap_or(false);
                if !resumable {
                    rec.remote = None;
                    rec.job.progress = 0.0;
                }
                rec.job.status = "queued".into();
                rec.job.stage = "Resuming…".into();
                rec.job.updated_at = now();
                let _ = st.db.upsert_job(&rec);
            }
        }
        let queue = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                queue.dispatch(&app);
                tokio::select! {
                    _ = queue.wake.notified() => {}
                    _ = tokio::time::sleep(Duration::from_secs(3)) => {}
                }
            }
        });
    }

    fn dispatch<R: Runtime>(&self, app: &AppHandle<R>) {
        let st = app.state::<AppState>();
        let Ok(queued) = st.db.jobs_with_status(&["queued"]) else { return };
        for rec in queued {
            let token = {
                let mut running = self.running.lock().expect("queue lock");
                if running.len() >= MAX_CONCURRENT {
                    return;
                }
                if running.contains_key(&rec.job.id) {
                    continue;
                }
                let token = CancellationToken::new();
                running.insert(rec.job.id.clone(), (token.clone(), rec.job.project_id.clone()));
                token
            };
            let app = app.clone();
            let queue = self.clone();
            tauri::async_runtime::spawn(async move {
                let id = rec.job.id.clone();
                run_job(&app, rec, token).await;
                queue.running.lock().expect("queue lock").remove(&id);
                queue.kick();
            });
        }
    }
}

/* ------------------------------- Job runner ------------------------------- */

fn emit<R: Runtime>(app: &AppHandle<R>, job: &Job) {
    let _ = app.emit("jobs://update", job);
}

fn save<R: Runtime>(app: &AppHandle<R>, rec: &JobRecord) {
    let st = app.state::<AppState>();
    if let Err(e) = st.db.upsert_job(rec) {
        log::error!("failed to persist job {}: {}", rec.job.id, e.message);
    }
    emit(app, &rec.job);
}

fn fail<R: Runtime>(app: &AppHandle<R>, rec: &mut JobRecord, err: &AppError) {
    rec.job.status = if err.code == ErrorCode::Cancelled { "canceled".into() } else { "failed".into() };
    rec.job.stage = if err.code == ErrorCode::Cancelled { "Canceled".into() } else { "Failed".into() };
    rec.job.error = (err.code != ErrorCode::Cancelled).then(|| JobError::from(err));
    rec.job.finished_at = Some(now());
    rec.job.updated_at = now();
    save(app, rec);
    if err.code != ErrorCode::Cancelled {
        let _ = app.state::<AppState>().db.record_usage(&rec.job.provider, &rec.job.kind, false, 0.0);
    }
}

pub fn read_staged(st: &AppState, id: &str) -> AppResult<ImageInput> {
    let path = st.paths.staged_image(id)?;
    let bytes = std::fs::read(&path).map_err(|_| {
        AppError::new(ErrorCode::NotFound, "An input image is missing.").with_hint("Add the image again and regenerate.")
    })?;
    let mime = crate::glb::image_mime(&bytes).ok_or_else(|| AppError::new(ErrorCode::Validation, "An input image is unreadable."))?;
    let name = st.staged(id).map(|s| s.name).unwrap_or_else(|_| "image".into());
    Ok(ImageInput { bytes, mime, name, view: None })
}

/// Merges params from the root of the version tree down to `version_id`.
pub fn lineage(st: &AppState, version_id: &str) -> AppResult<Value> {
    let mut chain = Vec::new();
    let mut cur = Some(version_id.to_string());
    while let Some(id) = cur.take() {
        if chain.len() > 256 {
            break;
        }
        let v = st.db.version(&id)?;
        cur = v.parent_id.clone();
        chain.push(v.params);
    }
    let mut merged = json!({});
    for params in chain.into_iter().rev() {
        providers::deep_merge(&mut merged, &params);
    }
    Ok(merged)
}

pub fn build_input(st: &AppState, spec: &JobSpec) -> AppResult<TaskInput> {
    let mut images = Vec::new();
    if let Some(g) = &spec.generate {
        for r in &g.images {
            let mut img = read_staged(st, safe_id(&r.image_id)?)?;
            img.view = r.view.clone();
            images.push(img);
        }
    }
    let source = match &spec.source_version_id {
        Some(id) => {
            let v = st.db.version(id)?;
            let lin = lineage(st, id)?;
            if images.is_empty() && spec.kind == JobKind::Refine {
                if let Some(derived) = lin.get("derivedImageId").and_then(Value::as_str) {
                    if let Ok(img) = read_staged(st, derived) {
                        images.push(img);
                    }
                }
            }
            Some(SourceModel { lineage: lin, bytes: library::version_bytes(st, &v.id)? })
        }
        None => None,
    };
    Ok(TaskInput { spec: spec.clone(), images, source })
}

fn stage_image_fn(st: &AppState) -> impl Fn(&str, &[u8]) -> AppResult<String> + Send + Sync + '_ {
    move |name: &str, bytes: &[u8]| crate::files::stage_bytes(st, name, bytes).map(|s| s.id)
}

fn version_label(spec: &JobSpec, variant: bool) -> String {
    match spec.kind {
        JobKind::Generate if variant => format!("Variant {}", spec.variant_index + 1),
        JobKind::Generate if spec.generate.as_ref().is_some_and(|g| g.quality == "draft") => "Draft".into(),
        JobKind::Generate => "Generated".into(),
        JobKind::Refine => "Refined · HQ".into(),
        JobKind::Retexture => "Retextured".into(),
        JobKind::Rig => format!("Rigged · {}", spec.animation.as_deref().unwrap_or("idle")),
    }
}

/// Animates progress for providers that don't report it (eases toward 92%).
fn synthetic_progress(started: Instant, expected: Duration, floor: f64) -> f64 {
    let t = started.elapsed().as_secs_f64() / expected.as_secs_f64().max(1.0);
    (floor + (0.92 - floor) * (1.0 - (-2.2 * t).exp())).min(0.92)
}

async fn run_job<R: Runtime>(app: &AppHandle<R>, mut rec: JobRecord, token: CancellationToken) {
    let st = app.state::<AppState>();
    let mut spec: JobSpec = match serde_json::from_value(rec.spec.clone()) {
        Ok(s) => s,
        Err(_) => return fail(app, &mut rec, &AppError::internal("This job's data is corrupt.")),
    };
    let input = match build_input(&st, &spec) {
        Ok(i) => i,
        Err(e) => return fail(app, &mut rec, &e),
    };
    let stage_fn = stage_image_fn(&st);
    let read_fn = |id: &str| read_staged(&st, id);

    loop {
        let provider = match providers::get(&rec.job.provider) {
            Ok(p) => p,
            Err(e) => return fail(app, &mut rec, &e),
        };
        let settings = st.settings.get();
        let ctx = Ctx {
            net: &st.net,
            key: secrets::get(&rec.job.provider).ok().flatten(),
            settings: settings.clone(),
            cancel: token.clone(),
            stage_image: &stage_fn,
            read_staged: &read_fn,
        };
        if let Err(e) = provider.check(&input, &settings) {
            return fail(app, &mut rec, &e);
        }

        rec.job.status = "running".into();
        rec.job.attempts += 1;
        rec.job.started_at.get_or_insert_with(now);
        rec.job.error = None;
        if rec.remote.is_none() {
            rec.job.stage = "Starting…".into();
            rec.job.progress = rec.job.progress.max(0.02);
            save(app, &rec);
            let created = tokio::select! {
                _ = token.cancelled() => return fail(app, &mut rec, &crate::net::cancelled()),
                r = provider.create_task(&ctx, &input) => r,
            };
            match created {
                Ok(handle) => rec.remote = Some(handle),
                Err(e) if rec.job.provider == "local" && settings.auto_web_fallback && matches!(e.code, ErrorCode::Network | ErrorCode::Provider | ErrorCode::Timeout) => {
                    // Local GPU unreachable: fall back to the free web Space.
                    spec.fallback_from = Some("local".into());
                    rec.spec = serde_json::to_value(&spec).unwrap_or(Value::Null);
                    rec.job.provider = "hfspace".into();
                    rec.job.stage = "Local GPU offline — switching to free web generation".into();
                    save(app, &rec);
                    continue;
                }
                Err(e) => return fail(app, &mut rec, &e),
            }
        }
        save(app, &rec);
        break;
    }

    let provider = match providers::get(&rec.job.provider) {
        Ok(p) => p,
        Err(e) => return fail(app, &mut rec, &e),
    };
    let expected = provider.expected_duration(spec.kind);
    let started = Instant::now();
    let floor = rec.job.progress;
    let mut handle = rec.remote.clone().unwrap_or(Value::Null);
    let mut errors = 0u32;
    let mut last_save = Instant::now();

    loop {
        let settings = st.settings.get();
        let ctx = Ctx {
            net: &st.net,
            key: secrets::get(&rec.job.provider).ok().flatten(),
            settings,
            cancel: token.clone(),
            stage_image: &stage_fn,
            read_staged: &read_fn,
        };
        let poll = tokio::select! {
            biased;
            _ = token.cancelled() => {
                let outcome = provider.cancel(&ctx, &handle).await.unwrap_or(CancelOutcome::LocalOnly);
                rec.job.status = "canceled".into();
                rec.job.stage = match outcome {
                    CancelOutcome::Cancelled => "Canceled".into(),
                    CancelOutcome::LocalOnly if provider.meta().free => "Canceled".into(),
                    CancelOutcome::LocalOnly => format!("Stopped tracking — {} may still finish (and bill) it", provider.meta().name),
                };
                rec.job.finished_at = Some(now());
                rec.job.updated_at = now();
                return save(app, &rec);
            }
            // Long-polling providers (Gradio streams) keep the bar moving while we wait.
            p = async {
                let fut = provider.get_status(&ctx, &input, &mut handle);
                tokio::pin!(fut);
                loop {
                    tokio::select! {
                        r = &mut fut => break r,
                        _ = tokio::time::sleep(Duration::from_millis(400)) => {
                            let p = synthetic_progress(started, expected, floor);
                            if p > rec.job.progress + 0.004 {
                                rec.job.progress = p;
                                rec.job.updated_at = now();
                                emit(app, &rec.job);
                            }
                        }
                    }
                }
            } => p,
        };

        if handle != *rec.remote.as_ref().unwrap_or(&Value::Null) {
            rec.remote = Some(handle.clone());
            save(app, &rec);
        }

        match poll {
            Err(e) => {
                if e.code == ErrorCode::Cancelled {
                    return fail(app, &mut rec, &e);
                }
                // Polling is idempotent: ride out blips (and offline periods) before giving up.
                errors += 1;
                let transient = matches!(e.code, ErrorCode::Network | ErrorCode::Offline | ErrorCode::Timeout | ErrorCode::RateLimited);
                if !transient || errors > if e.code == ErrorCode::Offline { 180 } else { 8 } {
                    return fail(app, &mut rec, &e);
                }
                rec.job.stage = if e.code == ErrorCode::Offline { "Waiting for an internet connection…".into() } else { "Reconnecting…".into() };
                emit(app, &rec.job);
                tokio::select! {
                    _ = token.cancelled() => continue,
                    _ = tokio::time::sleep(Duration::from_secs((errors as u64 * 2).min(10))) => continue,
                }
            }
            Ok(p) => {
                errors = 0;
                match p.state {
                    RemoteState::Queued | RemoteState::Running => {
                        let progress = p.progress.unwrap_or_else(|| synthetic_progress(started, expected, floor));
                        let stage_changed = rec.job.stage != p.stage;
                        rec.job.progress = progress.max(rec.job.progress).min(0.99);
                        rec.job.stage = p.stage;
                        rec.job.status = if p.state == RemoteState::Queued && rec.job.progress < 0.05 { "queued".into() } else { "running".into() };
                        if rec.job.status == "queued" {
                            rec.job.status = "running".into(); // still owned by a runner; show the provider's queue in the stage text
                        }
                        rec.job.updated_at = now();
                        if stage_changed || last_save.elapsed() > Duration::from_secs(5) {
                            save(app, &rec);
                            last_save = Instant::now();
                        } else {
                            emit(app, &rec.job);
                        }
                    }
                    RemoteState::Failed => {
                        let err = p.error.unwrap_or_else(|| AppError::new(ErrorCode::Provider, "The provider couldn't complete this job."));
                        return fail(app, &mut rec, &err);
                    }
                    RemoteState::Succeeded => {
                        rec.job.status = "downloading".into();
                        rec.job.stage = "Downloading model".into();
                        rec.job.progress = rec.job.progress.max(0.95);
                        save(app, &rec);
                        let bytes = match p.result {
                            Some(ModelSource::Bytes(b)) => Ok(b),
                            Some(ModelSource::Url(u)) => st.net.download(provider.meta().name, &u, &token).await,
                            None => Err(AppError::new(ErrorCode::Provider, "The provider returned no model.")),
                        };
                        let bytes = match bytes {
                            Ok(b) => b,
                            Err(e) => return fail(app, &mut rec, &e),
                        };
                        match finish(app, &st, &mut rec, &spec, bytes, p.origin, p.credits) {
                            Ok(()) => return,
                            Err(e) => return fail(app, &mut rec, &e),
                        }
                    }
                }
                tokio::select! {
                    _ = token.cancelled() => {}
                    _ = tokio::time::sleep(provider.poll_interval()) => {}
                }
            }
        }
    }
}

fn finish<R: Runtime>(app: &AppHandle<R>, st: &AppState, rec: &mut JobRecord, spec: &JobSpec, bytes: Vec<u8>, origin: Value, credits: Option<f64>) -> AppResult<()> {
    if !crate::glb::is_glb(&bytes) {
        return Err(AppError::new(ErrorCode::Provider, "The provider returned a file that isn't a GLB model.").with_hint("Retry the job."));
    }
    let variant = rec.job.variant_group.is_some();
    let mut params = json!({});
    if let Some(g) = &spec.generate {
        if spec.kind == JobKind::Generate {
            params["request"] = serde_json::to_value(g).unwrap_or(Value::Null);
            params["prompt"] = json!(g.prompt);
            params["quality"] = json!(g.quality);
            params["style"] = json!(g.style);
        }
    }
    if variant {
        params["variant"] = json!(spec.variant_index);
    }
    if let Some(t) = &spec.texture_prompt {
        params["texturePrompt"] = json!(t);
    }
    if let Some(a) = &spec.animation {
        params["animation"] = json!(a);
    }
    if let Some(f) = &spec.fallback_from {
        params["fallbackFrom"] = json!(f);
    }
    providers::deep_merge(&mut params, &origin);
    let version = library::add_version(
        app,
        st,
        NewVersionMeta {
            project_id: rec.job.project_id.clone(),
            parent_id: rec.job.parent_version_id.clone().or(spec.source_version_id.clone()),
            kind: spec.kind.as_str().into(),
            label: version_label(spec, variant),
            params,
        },
        &bytes,
        VersionExtra {
            provider: Some(rec.job.provider.clone()),
            variant_group: rec.job.variant_group.clone(),
            variant_index: rec.job.variant_index,
            make_current: Some(!variant || spec.variant_index == 0),
        },
    )?;
    let _ = st.db.record_usage(&rec.job.provider, &rec.job.kind, true, credits.unwrap_or(0.0));
    rec.job.status = "succeeded".into();
    rec.job.stage = "Done".into();
    rec.job.progress = 1.0;
    rec.job.result_version_id = Some(version.id);
    rec.job.finished_at = Some(now());
    rec.job.updated_at = now();
    save(app, rec);
    notify_done(app, &rec.job);
    Ok(())
}

fn notify_done<R: Runtime>(app: &AppHandle<R>, job: &Job) {
    use tauri_plugin_notification::NotificationExt;
    let st = app.state::<AppState>();
    if !st.settings.get().notifications {
        return;
    }
    let focused = app.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(true);
    if focused {
        return;
    }
    let title = match job.kind.as_str() {
        "refine" => "Refine finished",
        "retexture" => "Retexture finished",
        "rig" => "Rigging finished",
        _ => "Your model is ready",
    };
    let _ = app.notification().builder().title(title).body(&job.title).show();
}

/* -------------------------------- Commands -------------------------------- */

const STYLES: &[&str] = &["realistic", "stylized", "cartoon", "lowpoly", "voxel", "sculpture"];
const QUALITIES: &[&str] = &["draft", "standard", "high"];
const MODES: &[&str] = &["text", "image", "multiview"];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateRequest {
    pub project_id: Option<String>,
    pub parent_version_id: Option<String>,
    #[serde(flatten)]
    pub spec: GenerateSpec,
    pub variants: u32,
    pub provider: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateResult {
    pub project_id: String,
    pub job_ids: Vec<String>,
}

fn validate_spec(g: &GenerateSpec) -> AppResult<()> {
    let bad = |m: &str| Err(AppError::new(ErrorCode::Validation, m.to_string()));
    if !MODES.contains(&g.mode.as_str()) || !STYLES.contains(&g.style.as_str()) || !QUALITIES.contains(&g.quality.as_str()) {
        return bad("Invalid generation options.");
    }
    if g.prompt.chars().count() > 2000 || g.negative_prompt.as_ref().is_some_and(|n| n.chars().count() > 1000) {
        return bad("The prompt is too long.");
    }
    if g.mode == "text" && g.prompt.trim().is_empty() {
        return bad("Describe what you want to make first.");
    }
    if g.mode != "text" && g.images.is_empty() {
        return Err(AppError::new(ErrorCode::Validation, "Add an image first.").with_hint("Drop a PNG, JPEG or WebP onto the window, or click to browse."));
    }
    if g.images.len() > 4 || g.face_limit.is_some_and(|f| !(500..=500_000).contains(&f)) {
        return bad("Invalid generation options.");
    }
    for img in &g.images {
        safe_id(&img.image_id)?;
    }
    Ok(())
}

/// "a cute robot dog" → "Cute Robot Dog" (mirrors the frontend helper).
pub fn name_from_prompt(prompt: &str, fallback: &str) -> String {
    const STOP: &[&str] = &["a", "an", "the", "of", "with", "and", "in", "on", "for", "to", "low", "poly"];
    let words: Vec<String> = prompt
        .split(|c: char| !(c.is_alphanumeric() || c == '-'))
        .filter(|w| !w.is_empty())
        .enumerate()
        .filter(|(i, w)| *i > 0 || !STOP.contains(&w.to_lowercase().as_str()))
        .map(|(_, w)| w.to_string())
        .take(4)
        .collect();
    let keep_stops = words.len() <= 2;
    let name: Vec<String> = words
        .into_iter()
        .filter(|w| keep_stops || !STOP.contains(&w.to_lowercase().as_str()))
        .map(|w| {
            let lower = w.to_lowercase();
            let mut c = lower.chars();
            c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
        })
        .collect();
    if name.is_empty() {
        fallback.to_string()
    } else {
        name.join(" ")
    }
}

fn require_available(provider: &str, mode: Option<&str>, kind: JobKind, st: &AppState) -> AppResult<()> {
    let p = providers::get(provider)?;
    let meta = p.meta();
    if meta.requires_key && !secrets::has(provider) {
        return Err(AppError::new(ErrorCode::Auth, format!("{} needs an API key.", meta.name)).with_hint(format!("Add your {} key in Settings → Providers.", meta.name)));
    }
    let caps = p.capabilities(&st.settings.get());
    let ok = match kind {
        JobKind::Generate => match mode {
            Some("image") => caps.image,
            Some("multiview") => caps.multiview,
            _ => caps.text,
        },
        JobKind::Refine => caps.refine,
        JobKind::Retexture => caps.retexture,
        JobKind::Rig => caps.rig,
    };
    if !ok {
        return Err(AppError::new(ErrorCode::Unsupported, format!("{} doesn't support that.", meta.name)).with_hint("Pick another provider in the Create panel."));
    }
    Ok(())
}

struct NewJob<'a> {
    project_id: &'a str,
    title: &'a str,
    provider: &'a str,
    spec: &'a JobSpec,
    variant_group: Option<String>,
    parent: Option<String>,
}

fn enqueue<R: Runtime>(app: &AppHandle<R>, st: &AppState, new: NewJob<'_>) -> AppResult<String> {
    let NewJob { project_id, title, provider, spec, variant_group, parent } = new;
    let t = now();
    let rec = JobRecord {
        job: Job {
            id: new_id("j_"),
            project_id: project_id.into(),
            kind: spec.kind.as_str().into(),
            provider: provider.into(),
            status: "queued".into(),
            progress: 0.0,
            stage: "Waiting in queue".into(),
            title: title.chars().take(140).collect(),
            variant_group: variant_group.clone(),
            variant_index: variant_group.as_ref().map(|_| spec.variant_index as i64),
            parent_version_id: parent,
            result_version_id: None,
            error: None,
            attempts: 0,
            created_at: t.clone(),
            updated_at: t,
            started_at: None,
            finished_at: None,
        },
        spec: serde_json::to_value(spec)?,
        remote: None,
    };
    st.db.upsert_job(&rec)?;
    emit(app, &rec.job);
    Ok(rec.job.id)
}

#[tauri::command]
pub fn generate<R: Runtime>(app: AppHandle<R>, st: State<'_, AppState>, req: GenerateRequest) -> AppResult<GenerateResult> {
    validate_spec(&req.spec)?;
    if req.variants != 1 && req.variants != 4 {
        return Err(AppError::new(ErrorCode::Validation, "Choose 1 or 4 variants."));
    }
    require_available(&req.provider, Some(&req.spec.mode), JobKind::Generate, &st)?;
    let spec0 = JobSpec { kind: JobKind::Generate, generate: Some(req.spec.clone()), variant_index: 0, source_version_id: None, texture_prompt: None, animation: None, fallback_from: None };
    // Fail fast on unsupported combinations before creating anything.
    providers::get(&req.provider)?.check(&build_input(&st, &spec0)?, &st.settings.get())?;

    let image_names: Vec<String> = req.spec.images.iter().filter_map(|i| st.staged(&i.image_id).ok().map(|s| s.name)).collect();
    let title_source = if req.spec.prompt.trim().is_empty() { image_names.join(" ").replace(['_', '-'], " ") } else { req.spec.prompt.clone() };
    let title_source = title_source.trim_end_matches(".png").trim_end_matches(".jpg").trim_end_matches(".jpeg").trim_end_matches(".webp").to_string();
    let project = match &req.project_id {
        Some(id) => {
            let mut p = st.db.project(safe_id(id)?)?;
            if !req.spec.prompt.trim().is_empty() {
                p.prompt = req.spec.prompt.clone();
            }
            p.style = Some(req.spec.style.clone());
            p.provider = Some(req.provider.clone());
            p.updated_at = now();
            st.db.update_project(&p)?;
            p
        }
        None => library::create_project(&st, &name_from_prompt(&title_source, "Untitled model"), &req.spec.prompt, Some(req.spec.style.clone()), Some(req.provider.clone()))?,
    };
    let group = (req.variants > 1).then(|| new_id("g_"));
    let title = if title_source.trim().is_empty() { "New model".to_string() } else { title_source.trim().to_string() };
    let mut job_ids = Vec::new();
    for i in 0..req.variants {
        let spec = JobSpec { variant_index: i, ..spec0.clone() };
        let t = if req.variants > 1 { format!("{title} · variant {}", i + 1) } else { title.clone() };
        job_ids.push(enqueue(
            &app,
            &st,
            NewJob { project_id: &project.id, title: &t, provider: &req.provider, spec: &spec, variant_group: group.clone(), parent: req.parent_version_id.clone() },
        )?);
    }
    library::emit(&app, library::LibraryEvent::Project { project_id: project.id.clone() });
    st.jobs.kick();
    Ok(GenerateResult { project_id: project.id, job_ids })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRequest {
    pub project_id: String,
    pub version_id: String,
    pub provider: String,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub style: Option<String>,
    #[serde(default)]
    pub pbr: Option<bool>,
    #[serde(default)]
    pub animation: Option<String>,
}

fn source_job<R: Runtime>(app: &AppHandle<R>, st: &AppState, req: &SourceRequest, kind: JobKind) -> AppResult<String> {
    let v = st.db.version(safe_id(&req.version_id)?)?;
    if v.project_id != req.project_id {
        return Err(AppError::new(ErrorCode::Validation, "That version belongs to another project."));
    }
    require_available(&req.provider, None, kind, st)?;
    let lin = lineage(st, &v.id)?;
    // Refines re-use the original request (prompt, images, seed) at the highest quality.
    let mut generate: Option<GenerateSpec> = lin.get("request").cloned().and_then(|r| serde_json::from_value(r).ok());
    if let Some(g) = generate.as_mut() {
        if kind == JobKind::Refine {
            g.quality = "high".into();
        }
        if let Some(s) = &req.style {
            g.style = s.clone();
        }
        if let Some(p) = req.pbr {
            g.pbr = p;
        }
    }
    let texture_prompt = match kind {
        JobKind::Retexture => {
            let p = req.prompt.clone().unwrap_or_default();
            if p.trim().is_empty() {
                return Err(AppError::new(ErrorCode::Validation, "Describe the new texture first."));
            }
            Some(p.chars().take(800).collect())
        }
        _ => None,
    };
    let animation = match kind {
        JobKind::Rig => {
            let a = req.animation.clone().unwrap_or_else(|| "idle".into());
            if !["idle", "walk", "run"].contains(&a.as_str()) {
                return Err(AppError::new(ErrorCode::Validation, "Choose idle, walk or run."));
            }
            Some(a)
        }
        _ => None,
    };
    let spec = JobSpec { kind, generate, variant_index: 0, source_version_id: Some(v.id.clone()), texture_prompt: texture_prompt.clone(), animation: animation.clone(), fallback_from: None };
    providers::get(&req.provider)?.check(&build_input(st, &spec)?, &st.settings.get())?;
    let title = match kind {
        JobKind::Refine => format!("Refine · {}", v.label),
        JobKind::Retexture => format!("Retexture · {}", texture_prompt.unwrap_or_default()),
        JobKind::Rig => format!("Rig · {}", animation.unwrap_or_default()),
        JobKind::Generate => v.label.clone(),
    };
    let id = enqueue(app, st, NewJob { project_id: &v.project_id, title: &title, provider: &req.provider, spec: &spec, variant_group: None, parent: Some(v.id.clone()) })?;
    st.jobs.kick();
    Ok(id)
}

#[tauri::command]
pub fn refine<R: Runtime>(app: AppHandle<R>, st: State<'_, AppState>, req: SourceRequest) -> AppResult<String> {
    source_job(&app, &st, &req, JobKind::Refine)
}

#[tauri::command]
pub fn retexture<R: Runtime>(app: AppHandle<R>, st: State<'_, AppState>, req: SourceRequest) -> AppResult<String> {
    source_job(&app, &st, &req, JobKind::Retexture)
}

#[tauri::command]
pub fn rig<R: Runtime>(app: AppHandle<R>, st: State<'_, AppState>, req: SourceRequest) -> AppResult<String> {
    source_job(&app, &st, &req, JobKind::Rig)
}

#[tauri::command]
pub fn list_jobs(st: State<'_, AppState>) -> AppResult<Vec<Job>> {
    Ok(st.db.jobs()?.into_iter().map(|r| r.job).collect())
}

#[tauri::command]
pub fn cancel_job<R: Runtime>(app: AppHandle<R>, st: State<'_, AppState>, id: String) -> AppResult<()> {
    let Some(mut rec) = st.db.job_opt(safe_id(&id)?)? else { return Ok(()) };
    if !ACTIVE.contains(&rec.job.status.as_str()) {
        return Ok(());
    }
    if !st.jobs.cancel_token(&id) && !st.jobs.is_running(&id) {
        rec.job.status = "canceled".into();
        rec.job.stage = "Canceled".into();
        rec.job.finished_at = Some(now());
        rec.job.updated_at = now();
        save(&app, &rec);
    }
    Ok(())
}

#[tauri::command]
pub fn retry_job<R: Runtime>(app: AppHandle<R>, st: State<'_, AppState>, id: String) -> AppResult<()> {
    let mut rec = st.db.job(safe_id(&id)?)?;
    if !["failed", "canceled"].contains(&rec.job.status.as_str()) {
        return Ok(());
    }
    rec.job.status = "queued".into();
    rec.job.stage = "Waiting in queue".into();
    rec.job.progress = 0.0;
    rec.job.error = None;
    rec.job.finished_at = None;
    rec.job.started_at = None;
    rec.job.updated_at = now();
    rec.remote = None;
    save(&app, &rec);
    st.jobs.kick();
    Ok(())
}

#[tauri::command]
pub fn dismiss_job(st: State<'_, AppState>, id: String) -> AppResult<()> {
    st.jobs.cancel_token(safe_id(&id)?);
    st.db.delete_job(&id)
}

#[tauri::command]
pub fn clear_finished_jobs(st: State<'_, AppState>) -> AppResult<()> {
    st.db.delete_finished_jobs()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EstimateRequest {
    pub variants: Option<u32>,
    #[serde(flatten)]
    pub spec: Option<GenerateSpec>,
}

#[tauri::command]
pub fn estimate_cost(st: State<'_, AppState>, provider: String, kind: JobKind, req: Option<Value>) -> AppResult<providers::CostEstimate> {
    let p = providers::get(&provider)?;
    let parsed: Option<EstimateRequest> = req.and_then(|r| serde_json::from_value(r).ok());
    let variants = parsed.as_ref().and_then(|r| r.variants).unwrap_or(1);
    let spec = parsed.and_then(|r| r.spec);
    let history = st.db.average_credits(&provider, kind.as_str()).ok().flatten();
    Ok(p.estimate_cost(kind, spec.as_ref(), variants, history))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_from_prompts() {
        assert_eq!(name_from_prompt("a cute robot dog", "x"), "Cute Robot Dog");
        assert_eq!(name_from_prompt("The sword of fire and ice", "x"), "Sword Fire");
        assert_eq!(name_from_prompt("", "Untitled"), "Untitled");
    }

    #[test]
    fn synthetic_progress_is_monotonic_and_capped() {
        let started = Instant::now() - Duration::from_secs(1000);
        let p = synthetic_progress(started, Duration::from_secs(60), 0.1);
        assert!(p <= 0.92 && p > 0.9);
        let fresh = synthetic_progress(Instant::now(), Duration::from_secs(60), 0.1);
        assert!((fresh - 0.1).abs() < 0.01);
    }

    #[test]
    fn spec_validation() {
        let mut g = GenerateSpec {
            mode: "text".into(),
            prompt: "robot".into(),
            negative_prompt: None,
            images: vec![],
            style: "stylized".into(),
            quality: "standard".into(),
            face_limit: None,
            pbr: true,
            seed: None,
        };
        assert!(validate_spec(&g).is_ok());
        g.mode = "image".into();
        assert!(validate_spec(&g).is_err());
        g.mode = "text".into();
        g.style = "hacker".into();
        assert!(validate_spec(&g).is_err());
    }
}
