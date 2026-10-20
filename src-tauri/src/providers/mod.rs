//! Generation providers. Each adapter implements [`Provider`]; the job queue drives
//! them through `create_task` → `get_status` (polled) → download, persisting the
//! provider handle so jobs survive restarts.

pub mod fal;
pub mod gradio;
pub mod hfspace;
pub mod local;
pub mod meshy;
pub mod mock;
pub mod projection;
pub mod tripo;

use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, AppResult, ErrorCode};
use crate::net::Net;
use crate::settings::Settings;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobKind {
    Generate,
    Refine,
    Retexture,
    Rig,
}

impl JobKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            JobKind::Generate => "generate",
            JobKind::Refine => "refine",
            JobKind::Retexture => "retexture",
            JobKind::Rig => "rig",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageRef {
    pub image_id: String,
    pub view: Option<String>,
}

/// The user's generation request (persisted with the job).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateSpec {
    pub mode: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub negative_prompt: Option<String>,
    #[serde(default)]
    pub images: Vec<ImageRef>,
    pub style: String,
    pub quality: String,
    #[serde(default)]
    pub face_limit: Option<u32>,
    #[serde(default = "yes")]
    pub pbr: bool,
    #[serde(default)]
    pub seed: Option<i64>,
}

fn yes() -> bool {
    true
}

/// Everything the engine needs to (re)run a job. Stored in `jobs.spec`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSpec {
    pub kind: JobKind,
    #[serde(default)]
    pub generate: Option<GenerateSpec>,
    #[serde(default)]
    pub variant_index: u32,
    #[serde(default)]
    pub source_version_id: Option<String>,
    #[serde(default)]
    pub texture_prompt: Option<String>,
    #[serde(default)]
    pub animation: Option<String>,
    /// Set when the job was re-routed (e.g. Local GPU → free web Space).
    #[serde(default)]
    pub fallback_from: Option<String>,
}

pub struct ImageInput {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
    pub name: String,
    pub view: Option<String>,
}

impl ImageInput {
    pub fn data_uri(&self) -> String {
        format!("data:{};base64,{}", self.mime, base64::engine::general_purpose::STANDARD.encode(&self.bytes))
    }
    pub fn ext(&self) -> &'static str {
        match self.mime {
            "image/png" => "png",
            "image/webp" => "webp",
            _ => "jpg",
        }
    }
}

/// The version a refine/retexture/rig job starts from.
pub struct SourceModel {
    /// The version's params, merged with its ancestors' provenance (task ids, sample id…).
    pub lineage: Value,
    pub bytes: Vec<u8>,
}

pub struct TaskInput {
    pub spec: JobSpec,
    pub images: Vec<ImageInput>,
    pub source: Option<SourceModel>,
}

impl TaskInput {
    pub fn generate(&self) -> AppResult<&GenerateSpec> {
        self.spec.generate.as_ref().ok_or_else(|| AppError::internal("Missing generation request."))
    }
}

pub struct Ctx<'a> {
    pub net: &'a Net,
    pub key: Option<String>,
    pub settings: Settings,
    pub cancel: CancellationToken,
    /// Saves an intermediate image (e.g. FLUX output) so later refines can reuse it.
    pub stage_image: &'a (dyn Fn(&str, &[u8]) -> AppResult<String> + Send + Sync),
    /// Loads a staged image by id.
    pub read_staged: &'a (dyn Fn(&str) -> AppResult<ImageInput> + Send + Sync),
}

impl Ctx<'_> {
    pub fn require_key(&self, provider: &str) -> AppResult<&str> {
        self.key.as_deref().ok_or_else(|| {
            AppError::new(ErrorCode::Auth, format!("{provider} needs an API key."))
                .with_hint(format!("Add your {provider} key in Settings → Providers."))
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteState {
    Queued,
    Running,
    Succeeded,
    Failed,
}

pub enum ModelSource {
    Url(String),
    Bytes(Vec<u8>),
}

pub struct Poll {
    pub state: RemoteState,
    /// 0..1, or `None` when the provider doesn't report progress (the queue then animates it).
    pub progress: Option<f64>,
    pub stage: String,
    pub result: Option<ModelSource>,
    pub error: Option<AppError>,
    pub credits: Option<f64>,
    /// Provenance stored in the new version's params (task ids for chaining, sample id…).
    pub origin: Value,
}

impl Poll {
    pub fn running(progress: Option<f64>, stage: impl Into<String>) -> Self {
        Self { state: RemoteState::Running, progress, stage: stage.into(), result: None, error: None, credits: None, origin: Value::Null }
    }
    pub fn queued(stage: impl Into<String>) -> Self {
        Self { state: RemoteState::Queued, ..Self::running(None, stage) }
    }
    pub fn failed(error: AppError) -> Self {
        Self { state: RemoteState::Failed, error: Some(error), ..Self::running(None, "Failed") }
    }
    pub fn done(result: ModelSource, origin: Value) -> Self {
        Self { state: RemoteState::Succeeded, progress: Some(1.0), stage: "Downloading model".into(), result: Some(result), error: None, credits: None, origin }
    }
}

pub enum CancelOutcome {
    Cancelled,
    /// The provider has no cancel API; we stop tracking but it may still finish (and bill).
    LocalOnly,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub text: bool,
    pub image: bool,
    pub multiview: bool,
    pub refine: bool,
    pub retexture: bool,
    pub rig: bool,
    pub negative_prompt: bool,
    pub face_limit: bool,
    pub seed: bool,
    pub pbr: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostEstimate {
    pub provider: String,
    pub amount: Option<f64>,
    pub unit: &'static str,
    pub label: String,
}

impl CostEstimate {
    pub fn free(provider: &str, label: impl Into<String>) -> Self {
        Self { provider: provider.into(), amount: None, unit: "free", label: label.into() }
    }
    pub fn credits(provider: &str, amount: f64, approx: bool, name: &str) -> Self {
        let n = amount.round();
        Self { provider: provider.into(), amount: Some(n), unit: "credits", label: format!("{}{n} credits on {name}", if approx { "≈" } else { "" }) }
    }
    pub fn usd(provider: &str, amount: f64, name: &str) -> Self {
        Self { provider: provider.into(), amount: Some(amount), unit: "usd", label: format!("~${amount:.2} on {name}") }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTest {
    pub ok: bool,
    pub latency_ms: Option<u64>,
    pub message: String,
    pub balance: Option<String>,
}

pub struct ProviderMeta {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub requires_key: bool,
    pub free: bool,
    pub dashboard_url: Option<&'static str>,
    pub docs_url: Option<&'static str>,
}

#[async_trait]
pub trait Provider: Send + Sync {
    fn meta(&self) -> ProviderMeta;
    fn capabilities(&self, settings: &Settings) -> Capabilities;
    fn poll_interval(&self) -> Duration {
        Duration::from_secs(3)
    }
    /// Expected wall time, used to animate progress when the provider reports none.
    fn expected_duration(&self, _kind: JobKind) -> Duration {
        Duration::from_secs(90)
    }
    /// Whether an in-flight task can be resumed after an app restart.
    fn resumable(&self) -> bool {
        true
    }
    fn estimate_cost(&self, kind: JobKind, spec: Option<&GenerateSpec>, variants: u32, history_avg: Option<f64>) -> CostEstimate;
    /// Rejects requests the provider can't handle, with a reason the UI shows verbatim.
    fn check(&self, input: &TaskInput, settings: &Settings) -> AppResult<()>;
    async fn create_task(&self, ctx: &Ctx<'_>, input: &TaskInput) -> AppResult<Value>;
    async fn get_status(&self, ctx: &Ctx<'_>, input: &TaskInput, handle: &mut Value) -> AppResult<Poll>;
    async fn cancel(&self, ctx: &Ctx<'_>, handle: &Value) -> AppResult<CancelOutcome>;
    async fn test_connection(&self, ctx: &Ctx<'_>) -> AppResult<ConnectionTest>;
}

pub const ALL: &[&str] = &["mock", "tripo", "meshy", "fal", "local", "hfspace"];

pub fn get(id: &str) -> AppResult<&'static dyn Provider> {
    Ok(match id {
        "mock" => &mock::Mock,
        "tripo" => &tripo::Tripo,
        "meshy" => &meshy::Meshy,
        "fal" => &fal::Fal,
        "local" => &local::Local,
        "hfspace" => &hfspace::HfSpace,
        _ => return Err(AppError::new(ErrorCode::Validation, "Unknown provider.")),
    })
}

/* ------------------------------ Shared helpers ------------------------------ */

pub fn style_phrase(style: &str) -> &'static str {
    match style {
        "realistic" => "photorealistic, physically based materials",
        "cartoon" => "cartoon style, bold colors, rounded shapes",
        "lowpoly" => "low-poly, flat-shaded facets",
        "voxel" => "voxel art made of cubes",
        "sculpture" => "sculpture, smooth stone surface",
        _ => "stylized game asset, hand-painted look",
    }
}

/// Prompt + style phrase, trimmed to a provider's limit.
pub fn styled_prompt(spec: &GenerateSpec, max: usize) -> String {
    let mut p = spec.prompt.trim().to_string();
    let phrase = style_phrase(&spec.style);
    if !p.to_lowercase().contains(phrase.split(',').next().unwrap_or_default()) {
        p = format!("{p}, {phrase}");
    }
    p.chars().take(max).collect()
}

pub fn unsupported(provider: &str, what: &str, hint: &str) -> AppError {
    AppError::new(ErrorCode::Unsupported, format!("{provider} can't {what}.")).with_hint(hint.to_string())
}

/// Reads a provider task id stored in a version's lineage, e.g. lineage["tripo"]["taskId"].
pub fn lineage_str<'a>(lineage: &'a Value, provider: &str, key: &str) -> Option<&'a str> {
    lineage.get(provider).and_then(|p| p.get(key)).and_then(Value::as_str)
}

pub fn pct(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).map(|p| (p / 100.0).clamp(0.0, 1.0))
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn deep_merge(into: &mut Value, from: &Value) {
    match (into, from) {
        (Value::Object(a), Value::Object(b)) => {
            for (k, v) in b {
                deep_merge(a.entry(k.clone()).or_insert(Value::Null), v);
            }
        }
        (slot, v) => *slot = v.clone(),
    }
}
