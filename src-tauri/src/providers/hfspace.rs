//! Free generation on public Hugging Face Spaces (shared ZeroGPU quota):
//! - text → image: `black-forest-labs/FLUX.1-schnell` (`/infer`)
//! - image → 3D: `tencent/Hunyuan3D-2` (`/shape_generation`, `/generation_all`)
//!
//! Anonymous ZeroGPU time is too short for `/generation_all` (it fails at once), so
//! without a token the shape is built with `/shape_generation`, simplified by the
//! Space's own `/on_export_click` (the raw mesh is ~2.5M triangles), and colored by
//! projecting the image. With a token, `/generation_all` is tried first.
//!
//! Endpoint signatures come from each Space's `/info`. An optional free HF token
//! (stored in Credential Manager) raises the daily GPU quota.

use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde_json::{json, Value};

use super::gradio::{file_of, Gradio};
use super::*;

pub const FLUX_SPACE: &str = "https://black-forest-labs-flux-1-schnell.hf.space";
pub const HUNYUAN_SPACE: &str = "https://tencent-hunyuan3d-2.hf.space";

pub struct HfSpace;

/// Quality → (endpoint, inference steps, octree resolution). Draft is shape-only and
/// colored locally by image projection, which also keeps it within 6 GB GPUs.
pub fn hunyuan_plan(quality: &str) -> (&'static str, u32, u32) {
    match quality {
        "draft" => ("/shape_generation", 5, 256),
        "high" => ("/generation_all", 30, 384),
        _ => ("/generation_all", 10, 256),
    }
}

/// Shape-only plan for the free Space (no textured endpoint without a token).
pub fn shape_plan(quality: &str) -> (&'static str, u32, u32) {
    match quality {
        "draft" => ("/shape_generation", 10, 256),
        "high" => ("/shape_generation", 30, 384),
        _ => ("/shape_generation", 20, 256),
    }
}

/// Triangle budget for the Space-side simplification of shape-only meshes.
pub fn target_faces(quality: &str) -> u32 {
    match quality {
        "draft" => 20_000,
        "high" => 80_000,
        _ => 40_000,
    }
}

/// Starts a Hunyuan3D-2 Gradio generation (Space or local `gradio_app.py`).
pub async fn start_hunyuan(g: &Gradio<'_>, image: &ImageInput, quality: &str, seed: i64) -> AppResult<(String, String)> {
    start_hunyuan_with(g, image, hunyuan_plan(quality), seed).await
}

pub async fn start_hunyuan_with(g: &Gradio<'_>, image: &ImageInput, (api, steps, octree): (&'static str, u32, u32), seed: i64) -> AppResult<(String, String)> {
    let file = g.upload(&image.bytes, &format!("input.{}", image.ext()), image.mime).await?;
    // caption, image, mv_front, mv_back, mv_left, mv_right, steps, guidance, seed, octree, remove_bg, num_chunks, randomize_seed
    let data = json!(["", file, null, null, null, null, steps, 5.0, seed, octree, true, 8000, false]);
    let event = g.call(api, data, None).await?;
    Ok((api.to_string(), event))
}

/// Picks the mesh from a finished Hunyuan3D-2 run: `/generation_all` returns
/// [white mesh, textured mesh, …]; `/shape_generation` returns [white mesh, …].
pub fn hunyuan_output(api: &str, out: &[Value]) -> AppResult<Value> {
    let idx = if api == "/generation_all" { 1 } else { 0 };
    out.get(idx).and_then(file_of).ok_or_else(|| AppError::new(ErrorCode::Provider, "The generator returned no model."))
}

pub async fn start_flux(g: &Gradio<'_>, prompt: &str, seed: Option<i64>) -> AppResult<String> {
    let full = format!("{prompt}, single object, centered, full view, plain white background, studio lighting");
    // prompt, seed, randomize_seed, width, height, num_inference_steps
    let data = json!([full, seed.unwrap_or(0), seed.is_none(), 1024, 1024, 4]);
    g.call("/infer", data, None).await
}

fn seed_for(g: Option<&GenerateSpec>, variant: u32) -> i64 {
    g.and_then(|g| g.seed).unwrap_or_else(|| (rand::random::<u32>() % 10_000_000) as i64) + variant as i64
}

async fn spaces<'a>(ctx: &'a Ctx<'_>, base: &str) -> AppResult<Gradio<'a>> {
    Gradio::connect(ctx.net, base, ctx.key.clone(), "The free Hugging Face Space").await
}

fn plan_for(ctx: &Ctx<'_>, quality: &str) -> (&'static str, u32, u32) {
    if ctx.key.is_some() {
        hunyuan_plan(quality)
    } else {
        shape_plan(quality)
    }
}

/// The image the mesh was built from: FLUX's reference for text, else the user's image.
fn source_image(ctx: &Ctx<'_>, input: &TaskInput, derived: &Option<String>) -> AppResult<Option<ImageInput>> {
    Ok(match derived {
        Some(id) => Some((ctx.read_staged)(id)?),
        None => input.images.first().cloned(),
    })
}

async fn finish(ctx: &Ctx<'_>, input: &TaskInput, mut bytes: Vec<u8>, api: &str, derived: Option<String>) -> AppResult<Poll> {
    if api == "/shape_generation" {
        if let Some(img) = source_image(ctx, input, &derived)? {
            bytes = projection::project_image(&bytes, &img.bytes, img.mime)?;
        }
    }
    let mut origin = json!({ "hfspace": { "space": "tencent/Hunyuan3D-2", "endpoint": api } });
    if let Some(id) = derived {
        origin["derivedImageId"] = json!(id);
    }
    Ok(Poll::done(ModelSource::Bytes(bytes), origin))
}

#[async_trait]
impl Provider for HfSpace {
    fn meta(&self) -> ProviderMeta {
        ProviderMeta {
            id: "hfspace",
            name: "Hugging Face (free)",
            description: "Free public Spaces (FLUX + Hunyuan3D-2). No account needed; a free token raises your daily GPU time.",
            requires_key: false,
            free: true,
            dashboard_url: Some("https://huggingface.co/settings/tokens"),
            docs_url: Some("https://huggingface.co/spaces/tencent/Hunyuan3D-2"),
        }
    }

    fn capabilities(&self, _: &Settings) -> Capabilities {
        Capabilities { text: true, image: true, multiview: false, refine: true, retexture: false, rig: false, negative_prompt: false, face_limit: false, seed: true, pbr: false }
    }

    fn poll_interval(&self) -> Duration {
        Duration::from_millis(500)
    }

    fn expected_duration(&self, kind: JobKind) -> Duration {
        Duration::from_secs(if kind == JobKind::Refine { 150 } else { 110 })
    }

    fn resumable(&self) -> bool {
        false
    }

    fn estimate_cost(&self, _: JobKind, _: Option<&GenerateSpec>, _: u32, _: Option<f64>) -> CostEstimate {
        CostEstimate::free("hfspace", "Free · shared GPU time")
    }

    fn check(&self, input: &TaskInput, _: &Settings) -> AppResult<()> {
        match input.spec.kind {
            JobKind::Retexture => Err(unsupported("The free Spaces", "retexture models", "Use Meshy or Tripo for retexturing.")),
            JobKind::Rig => Err(unsupported("The free Spaces", "rig models", "Use Meshy or Tripo for auto-rigging.")),
            JobKind::Generate if input.spec.generate.as_ref().is_some_and(|g| g.mode == "multiview") => Err(unsupported(
                "The free Spaces",
                "use multiple views",
                "Use the front image in Image mode, or pick fal.ai, Meshy or Tripo for multi-view.",
            )),
            JobKind::Refine if input.images.is_empty() => Err(unsupported("The free Spaces", "refine this model — the source image isn't available", "Generate it with this provider first.")),
            _ => Ok(()),
        }
    }

    async fn create_task(&self, ctx: &Ctx<'_>, input: &TaskInput) -> AppResult<Value> {
        let g = input.spec.generate.as_ref();
        let seed = seed_for(g, input.spec.variant_index);
        let quality = if input.spec.kind == JobKind::Refine { "high".to_string() } else { g.map(|g| g.quality.clone()).unwrap_or_else(|| "standard".into()) };
        if input.spec.kind == JobKind::Generate && g.is_some_and(|g| g.mode == "text") {
            let flux = spaces(ctx, FLUX_SPACE).await?;
            let event = start_flux(&flux, &styled_prompt(g.expect("checked"), 600), g.and_then(|g| g.seed).map(|s| s + input.spec.variant_index as i64)).await?;
            return Ok(json!({ "step": "image", "event": event, "quality": quality, "seed": seed }));
        }
        let image = input.images.first().ok_or_else(|| AppError::new(ErrorCode::Validation, "Add an image first."))?;
        let hy = spaces(ctx, HUNYUAN_SPACE).await?;
        let (api, event) = start_hunyuan_with(&hy, image, plan_for(ctx, &quality), seed).await?;
        Ok(json!({ "step": "mesh", "api": api, "event": event, "quality": quality }))
    }

    async fn get_status(&self, ctx: &Ctx<'_>, input: &TaskInput, handle: &mut Value) -> AppResult<Poll> {
        let step = handle["step"].as_str().unwrap_or("mesh").to_string();
        if step == "image" {
            let flux = spaces(ctx, FLUX_SPACE).await?;
            let out = flux.result("/infer", handle["event"].as_str().unwrap_or_default(), &ctx.cancel, Duration::from_secs(600)).await?;
            let file = out.first().ok_or_else(|| AppError::new(ErrorCode::Provider, "FLUX returned no image."))?;
            let bytes = flux.download(file, &ctx.cancel).await?;
            let image_id = (ctx.stage_image)("reference.png", &bytes)?;
            let image = (ctx.read_staged)(&image_id)?;
            let hy = spaces(ctx, HUNYUAN_SPACE).await?;
            let quality = handle["quality"].as_str().unwrap_or("standard").to_string();
            let seed = handle["seed"].as_i64().unwrap_or(1234);
            let (api, event) = start_hunyuan_with(&hy, &image, plan_for(ctx, &quality), seed).await?;
            *handle = json!({ "step": "mesh", "api": api, "event": event, "quality": quality, "imageId": image_id, "seed": seed });
            return Ok(Poll::running(Some(0.3), "Building the 3D model on Hugging Face"));
        }
        let hy = spaces(ctx, HUNYUAN_SPACE).await?;
        let quality = handle["quality"].as_str().unwrap_or("standard").to_string();
        let derived = handle["imageId"].as_str().map(str::to_string);

        if step == "reduce" {
            let original = handle["file"].clone();
            // Simplifying is a nicety: if it fails, keep the full-detail mesh.
            let reduced = match hy.result("/on_export_click", handle["event"].as_str().unwrap_or_default(), &ctx.cancel, Duration::from_secs(240)).await {
                Ok(out) => match out.get(1).and_then(file_of) {
                    Some(f) => hy.download(&f, &ctx.cancel).await.ok(),
                    None => None,
                },
                Err(e) if e.code == ErrorCode::Cancelled => return Err(e),
                Err(_) => None,
            };
            let bytes = match reduced {
                Some(b) => b,
                None => hy.download(&original, &ctx.cancel).await?,
            };
            return finish(ctx, input, bytes, "/shape_generation", derived).await;
        }

        let api = handle["api"].as_str().unwrap_or("/generation_all").to_string();
        let out = match hy.result(&api, handle["event"].as_str().unwrap_or_default(), &ctx.cancel, Duration::from_secs(900)).await {
            Ok(out) => out,
            // The textured endpoint needs more GPU time than the quota may allow; build the shape instead.
            Err(e) if api == "/generation_all" && e.code != ErrorCode::Cancelled => {
                let image = source_image(ctx, input, &derived)?.ok_or(e)?;
                let (api, event) = start_hunyuan_with(&hy, &image, shape_plan(&quality), handle["seed"].as_i64().unwrap_or(1234)).await?;
                handle["api"] = json!(api);
                handle["event"] = json!(event);
                return Ok(Poll::running(Some(0.45), "Not enough free GPU time for textures — building the shape"));
            }
            Err(e) => return Err(e),
        };
        let file = hunyuan_output(&api, &out)?;
        if api == "/shape_generation" {
            if let Ok(event) = hy.call("/on_export_click", json!([file, file, "glb", true, false, target_faces(&quality)]), None).await {
                *handle = json!({ "step": "reduce", "event": event, "file": file, "quality": quality, "imageId": derived });
                return Ok(Poll::running(Some(0.6), "Simplifying the mesh"));
            }
        }
        let bytes = hy.download(&file, &ctx.cancel).await?;
        finish(ctx, input, bytes, &api, derived).await
    }

    async fn cancel(&self, _: &Ctx<'_>, _: &Value) -> AppResult<CancelOutcome> {
        // Dropping the result stream releases our slot; Gradio has no explicit cancel over /call.
        Ok(CancelOutcome::LocalOnly)
    }

    async fn test_connection(&self, ctx: &Ctx<'_>) -> AppResult<ConnectionTest> {
        let start = Instant::now();
        let hy = spaces(ctx, HUNYUAN_SPACE).await?;
        let endpoints = hy.endpoints().await?;
        if !endpoints.iter().any(|e| e == "/generation_all") {
            return Ok(ConnectionTest {
                ok: false,
                latency_ms: Some(start.elapsed().as_millis() as u64),
                message: "The Hunyuan3D-2 Space changed its API — update Shift3D.".into(),
                balance: None,
            });
        }
        let mut message = "The free Hunyuan3D-2 Space is online.".to_string();
        if ctx.key.is_some() {
            let url = url::Url::parse("https://huggingface.co/api/whoami-v2").expect("static URL");
            let key = ctx.key.clone().unwrap_or_default();
            let who = ctx.net.json(&crate::net::Req::get("Hugging Face"), &url, |c, u| c.get(u.clone()).bearer_auth(&key)).await?;
            if let Some(name) = who["name"].as_str() {
                message = format!("Online · using {name}'s free GPU quota.");
            }
        }
        Ok(ConnectionTest { ok: true, latency_ms: Some(start.elapsed().as_millis() as u64), message, balance: None })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_by_quality() {
        assert_eq!(hunyuan_plan("draft").0, "/shape_generation");
        assert_eq!(hunyuan_plan("standard").0, "/generation_all");
        assert_eq!(hunyuan_plan("high").1, 30);
    }

    #[test]
    fn output_index() {
        let out = vec![json!({ "path": "white.glb" }), json!({ "path": "textured.glb" }), json!("<html>")];
        assert_eq!(hunyuan_output("/generation_all", &out).unwrap()["path"], "textured.glb");
        assert_eq!(hunyuan_output("/shape_generation", &out).unwrap()["path"], "white.glb");
        // Gradio 4 wraps outputs in component updates.
        let wrapped = vec![json!({ "value": { "path": "white.glb", "url": "https://x/call/shape/file=white.glb" }, "__type__": "update" })];
        assert_eq!(hunyuan_output("/shape_generation", &wrapped).unwrap()["path"], "white.glb");
        assert_eq!(shape_plan("standard").0, "/shape_generation");
    }
}
