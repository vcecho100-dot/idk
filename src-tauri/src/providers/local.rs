//! Self-hosted generation — 100% private when started from an image.
//!
//! Supported servers (detected by `probe`):
//! - `hunyuan3d`: Tencent's Hunyuan3D-2 `api_server.py` (`POST /send`, `GET /status/{uid}`).
//!   Defaults to Hunyuan3D-2mini, which fits **6 GB** for shapes; Shift3D colors the
//!   mesh by image projection unless the server paints textures.
//! - `hunyuan3d-gradio`: Hunyuan3D-2 `gradio_app.py` (`/shape_generation`, `/generation_all`).
//! - `trellis`: the TRELLIS Gradio app exposing `/generate_and_extract_glb`.
//!
//! These servers take images, not text: with "Use free web generation when needed"
//! on, text prompts get a reference image from the free FLUX Space first.

use std::time::{Duration, Instant};

use async_trait::async_trait;
use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use url::Url;

use super::gradio::{session_hash, Gradio};
use super::hfspace::{hunyuan_output, start_flux, start_hunyuan, FLUX_SPACE};
use super::*;
use crate::net::Req;
use crate::settings::validate_local_url;

const NAME: &str = "Local GPU";
/// The api_server never reports failures (a crashed job stays "processing" forever).
const LOCAL_TIMEOUT: Duration = Duration::from_secs(20 * 60);

pub struct Local;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalServerProbe {
    pub ok: bool,
    pub kind: Option<String>,
    pub message: String,
}

fn base_url(settings: &Settings) -> AppResult<Url> {
    validate_local_url(&settings.local_server_url)
}

fn join(base: &Url, path: &str) -> Url {
    let mut u = base.clone();
    u.set_path(&format!("{}{}", base.path().trim_end_matches('/'), path));
    u
}

/// Figures out what kind of generation server is running at `url`.
pub async fn probe(net: &crate::net::Net, url: &Url) -> LocalServerProbe {
    if let Ok(g) = Gradio::connect(net, url.as_str(), None, NAME).await {
        let endpoints = g.endpoints().await.unwrap_or_default();
        if endpoints.iter().any(|e| e == "/generation_all") {
            return LocalServerProbe { ok: true, kind: Some("hunyuan3d-gradio".into()), message: "Found Hunyuan3D-2 (Gradio app).".into() };
        }
        if endpoints.iter().any(|e| e == "/generate_and_extract_glb") {
            return LocalServerProbe { ok: true, kind: Some("trellis".into()), message: "Found TRELLIS (Gradio app).".into() };
        }
        return LocalServerProbe {
            ok: false,
            kind: None,
            message: "That's a Gradio app, but not one Shift3D knows. Run Hunyuan3D-2's gradio_app.py or the community TRELLIS app.".into(),
        };
    }
    let openapi = join(url, "/openapi.json");
    if let Ok(spec) = net.json(&Req::get(NAME).with_timeout(Duration::from_secs(8)), &openapi, |c, u| c.get(u.clone())).await {
        let paths = spec["paths"].as_object();
        if paths.is_some_and(|p| p.contains_key("/send") && p.keys().any(|k| k.starts_with("/status"))) {
            return LocalServerProbe { ok: true, kind: Some("hunyuan3d".into()), message: "Found the Hunyuan3D-2 API server.".into() };
        }
    }
    LocalServerProbe {
        ok: false,
        kind: None,
        message: format!("No generation server answered at {url}. Start it, then try again."),
    }
}

fn quality_of(input: &TaskInput) -> String {
    if input.spec.kind == JobKind::Refine {
        "high".into()
    } else {
        input.spec.generate.as_ref().map(|g| g.quality.clone()).unwrap_or_else(|| "standard".into())
    }
}

fn seed_of(input: &TaskInput) -> i64 {
    input.spec.generate.as_ref().and_then(|g| g.seed).unwrap_or_else(|| (rand::random::<u32>() % 1_000_000) as i64) + input.spec.variant_index as i64
}

async fn send_api(ctx: &Ctx<'_>, base: &Url, image: &ImageInput, quality: &str, seed: i64, face_limit: Option<u32>) -> AppResult<String> {
    let (steps, octree) = match quality {
        "draft" => (5, 196),
        "high" => (10, 380),
        _ => (5, 256),
    };
    let body = json!({
        "image": base64::engine::general_purpose::STANDARD.encode(&image.bytes),
        "seed": seed,
        "octree_resolution": octree,
        "num_inference_steps": steps,
        "guidance_scale": 5.0,
        "texture": ctx.settings.local_texture,
        "face_count": face_limit.unwrap_or(40_000),
        "type": "glb",
    });
    let resp = ctx.net.json(&Req::create(NAME).with_timeout(Duration::from_secs(60)), &join(base, "/send"), |c, u| c.post(u.clone()).json(&body)).await?;
    resp["uid"].as_str().map(str::to_string).ok_or_else(|| AppError::new(ErrorCode::Provider, "The local server didn't start the job."))
}

async fn start_mesh(ctx: &Ctx<'_>, input: &TaskInput, image: &ImageInput, image_id: Option<String>) -> AppResult<Value> {
    let base = base_url(&ctx.settings)?;
    let quality = quality_of(input);
    let seed = seed_of(input);
    let face_limit = input.spec.generate.as_ref().and_then(|g| g.face_limit);
    let mut handle = match ctx.settings.local_server_kind.as_str() {
        "hunyuan3d-gradio" => {
            let g = Gradio::connect(ctx.net, base.as_str(), None, NAME).await?;
            let (api, event) = start_hunyuan(&g, image, &quality, seed).await?;
            json!({ "kind": "gradio", "api": api, "event": event })
        }
        "trellis" => {
            let g = Gradio::connect(ctx.net, base.as_str(), None, NAME).await?;
            let session = session_hash();
            // The TRELLIS app keeps per-session temp folders, created by `start_session`.
            let ev = g.call("/start_session", json!([]), Some(&session)).await?;
            g.result("/start_session", &ev, &ctx.cancel, Duration::from_secs(60)).await?;
            let file = g.upload(&image.bytes, &format!("input.{}", image.ext()), image.mime).await?;
            let texture = if quality == "draft" { 1024 } else { 2048 };
            // image, multiimages, seed, ss_guidance, ss_steps, slat_guidance, slat_steps, multiimage_algo, mesh_simplify, texture_size
            let data = json!([file, [], seed, 7.5, 12, 3.0, 12, "stochastic", 0.95, texture]);
            let event = g.call("/generate_and_extract_glb", data, Some(&session)).await?;
            json!({ "kind": "trellis", "event": event })
        }
        _ => {
            let uid = send_api(ctx, &base, image, &quality, seed, face_limit).await?;
            json!({ "kind": "api", "uid": uid, "startedMs": now_ms(), "texture": ctx.settings.local_texture })
        }
    };
    if let Some(id) = image_id {
        handle["imageId"] = json!(id);
    }
    Ok(handle)
}

#[async_trait]
impl Provider for Local {
    fn meta(&self) -> ProviderMeta {
        ProviderMeta {
            id: "local",
            name: NAME,
            description: "Your own Hunyuan3D or TRELLIS server. 6 GB GPUs: Hunyuan3D-2mini shapes + Shift3D texture projection.",
            requires_key: false,
            free: true,
            dashboard_url: None,
            docs_url: Some("https://github.com/Tencent-Hunyuan/Hunyuan3D-2"),
        }
    }

    fn capabilities(&self, settings: &Settings) -> Capabilities {
        Capabilities {
            text: settings.auto_web_fallback,
            image: true,
            multiview: false,
            refine: true,
            retexture: false,
            rig: false,
            negative_prompt: false,
            face_limit: settings.local_server_kind == "hunyuan3d",
            seed: true,
            pbr: false,
        }
    }

    fn poll_interval(&self) -> Duration {
        Duration::from_secs(2)
    }

    fn expected_duration(&self, kind: JobKind) -> Duration {
        Duration::from_secs(if kind == JobKind::Refine { 120 } else { 70 })
    }

    fn resumable(&self) -> bool {
        // Gradio streams can't be re-attached; api_server jobs re-create cleanly too.
        false
    }

    fn estimate_cost(&self, _: JobKind, _: Option<&GenerateSpec>, _: u32, _: Option<f64>) -> CostEstimate {
        CostEstimate::free("local", "Free · runs on your GPU")
    }

    fn check(&self, input: &TaskInput, settings: &Settings) -> AppResult<()> {
        base_url(settings)?;
        match input.spec.kind {
            JobKind::Retexture => Err(unsupported(NAME, "retexture models", "Use Meshy or Tripo for retexturing.")),
            JobKind::Rig => Err(unsupported(NAME, "rig models", "Use Meshy or Tripo for auto-rigging.")),
            JobKind::Generate => {
                let g = input.generate()?;
                if g.mode == "multiview" {
                    return Err(unsupported(NAME, "use multiple views", "Use the front image in Image mode."));
                }
                if g.mode == "text" && !settings.auto_web_fallback {
                    return Err(unsupported(
                        NAME,
                        "turn text into 3D on its own — local servers only take images",
                        "Start from an image, or turn on “Use free web generation when needed” in Settings → Providers.",
                    ));
                }
                Ok(())
            }
            JobKind::Refine if input.images.is_empty() => Err(unsupported(NAME, "refine this model — the source image isn't available", "Generate it from an image first.")),
            JobKind::Refine => Ok(()),
        }
    }

    async fn create_task(&self, ctx: &Ctx<'_>, input: &TaskInput) -> AppResult<Value> {
        if input.spec.kind == JobKind::Generate {
            let g = input.generate()?;
            if g.mode == "text" {
                // Local servers need an image: draw one on the free FLUX Space first.
                let flux = Gradio::connect(ctx.net, FLUX_SPACE, None, "The free FLUX Space").await?;
                let event = start_flux(&flux, &styled_prompt(g, 600), g.seed).await?;
                return Ok(json!({ "kind": "flux", "event": event }));
            }
        }
        let image = input.images.first().ok_or_else(|| AppError::new(ErrorCode::Validation, "Add an image first."))?;
        start_mesh(ctx, input, image, None).await
    }

    async fn get_status(&self, ctx: &Ctx<'_>, input: &TaskInput, handle: &mut Value) -> AppResult<Poll> {
        let base = base_url(&ctx.settings)?;
        let derived = handle["imageId"].as_str().map(str::to_string);
        let bytes = match handle["kind"].as_str().unwrap_or("api") {
            "flux" => {
                let flux = Gradio::connect(ctx.net, FLUX_SPACE, None, "The free FLUX Space").await?;
                let out = flux.result("/infer", handle["event"].as_str().unwrap_or_default(), &ctx.cancel, Duration::from_secs(600)).await?;
                let file = out.first().ok_or_else(|| AppError::new(ErrorCode::Provider, "FLUX returned no image."))?;
                let png = flux.download(file, &ctx.cancel).await?;
                let id = (ctx.stage_image)("reference.png", &png)?;
                let image = (ctx.read_staged)(&id)?;
                *handle = start_mesh(ctx, input, &image, Some(id)).await?;
                return Ok(Poll::running(Some(0.3), "Building the shape on your GPU"));
            }
            "gradio" | "trellis" => {
                let g = Gradio::connect(ctx.net, base.as_str(), None, NAME).await?;
                let trellis = handle["kind"] == "trellis";
                let api = if trellis { "/generate_and_extract_glb".to_string() } else { handle["api"].as_str().unwrap_or("/generation_all").to_string() };
                let out = g.result(&api, handle["event"].as_str().unwrap_or_default(), &ctx.cancel, LOCAL_TIMEOUT).await?;
                let file = if trellis { out.get(1).cloned().ok_or_else(|| AppError::new(ErrorCode::Provider, "TRELLIS returned no model."))? } else { hunyuan_output(&api, &out)? };
                let b = g.download(&file, &ctx.cancel).await?;
                if !trellis && api == "/shape_generation" {
                    project(ctx, input, derived.as_deref(), b)?
                } else {
                    b
                }
            }
            _ => {
                let uid = handle["uid"].as_str().ok_or_else(|| AppError::internal("Lost the local job id."))?.to_string();
                if now_ms() - handle["startedMs"].as_i64().unwrap_or_else(now_ms) > LOCAL_TIMEOUT.as_millis() as i64 {
                    return Ok(Poll::failed(
                        AppError::new(ErrorCode::Timeout, "The local server didn't finish in 20 minutes.")
                            .with_hint("Check its console — a CUDA out-of-memory error usually means the quality is too high for your GPU."),
                    ));
                }
                let status = ctx
                    .net
                    .json(&Req::get(NAME).with_timeout(Duration::from_secs(120)), &join(&base, &format!("/status/{uid}")), |c, u| c.get(u.clone()))
                    .await?;
                if status["status"] != "completed" {
                    return Ok(Poll::running(None, "Generating on your GPU"));
                }
                let b64 = status["model_base64"].as_str().ok_or_else(|| AppError::new(ErrorCode::Provider, "The local server returned no model."))?;
                let raw = base64::engine::general_purpose::STANDARD
                    .decode(b64)
                    .map_err(|_| AppError::new(ErrorCode::Provider, "The local server returned a corrupt model."))?;
                if handle["texture"].as_bool().unwrap_or(false) {
                    raw
                } else {
                    project(ctx, input, derived.as_deref(), raw)?
                }
            }
        };
        let mut origin = json!({ "local": { "server": ctx.settings.local_server_kind } });
        if let Some(id) = derived {
            origin["derivedImageId"] = json!(id);
        }
        Ok(Poll::done(ModelSource::Bytes(bytes), origin))
    }

    async fn cancel(&self, _: &Ctx<'_>, _: &Value) -> AppResult<CancelOutcome> {
        Ok(CancelOutcome::LocalOnly)
    }

    async fn test_connection(&self, ctx: &Ctx<'_>) -> AppResult<ConnectionTest> {
        let start = Instant::now();
        let p = probe(ctx.net, &base_url(&ctx.settings)?).await;
        Ok(ConnectionTest { ok: p.ok, latency_ms: Some(start.elapsed().as_millis() as u64), message: p.message, balance: None })
    }
}

/// Colors a shape-only mesh with the source image.
fn project(ctx: &Ctx<'_>, input: &TaskInput, derived: Option<&str>, mesh: Vec<u8>) -> AppResult<Vec<u8>> {
    let staged = match derived {
        Some(id) => Some((ctx.read_staged)(id)?),
        None => None,
    };
    match staged.as_ref().or(input.images.first()) {
        Some(img) => projection::project_image(&mesh, &img.bytes, img.mime),
        None => Ok(mesh),
    }
}
