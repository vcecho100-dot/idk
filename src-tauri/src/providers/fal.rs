//! fal.ai queue API (<https://queue.fal.run/{model}>), auth `Authorization: Key …`.
//!
//! Models (from fal's model pages):
//! - `fal-ai/trellis` (image_url → model_mesh): fast, textured, $0.02
//! - `fal-ai/trellis/multi` (image_urls → model_mesh): multi-view
//! - `fal-ai/hunyuan3d/v2` (input_image_url, textured_mesh): highest quality
//! - `fal-ai/flux/schnell` (prompt → images[]): text → reference image
//!
//! Status/result/cancel use the URLs returned at submit time, as fal recommends.

use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde_json::{json, Value};
use url::Url;

use super::*;
use crate::net::Req;

const QUEUE: &str = "https://queue.fal.run";
const NAME: &str = "fal.ai";
const TRELLIS: &str = "fal-ai/trellis";
const TRELLIS_MULTI: &str = "fal-ai/trellis/multi";
const HUNYUAN: &str = "fal-ai/hunyuan3d/v2";
const FLUX: &str = "fal-ai/flux/schnell";

pub struct Fal;

async fn submit(ctx: &Ctx<'_>, model: &str, body: Value) -> AppResult<Value> {
    let key = ctx.require_key(NAME)?.to_string();
    let url = Url::parse(&format!("{QUEUE}/{model}")).expect("static URL");
    let resp = ctx
        .net
        .json(&Req::create(NAME).with_timeout(Duration::from_secs(180)), &url, |c, u| c.post(u.clone()).header("Authorization", format!("Key {key}")).json(&body))
        .await?;
    let get = |k: &str| resp.get(k).and_then(Value::as_str).map(str::to_string);
    let (Some(status), Some(response)) = (get("status_url"), get("response_url")) else {
        return Err(AppError::new(ErrorCode::Provider, "fal.ai didn't accept the request."));
    };
    Ok(json!({ "model": model, "requestId": get("request_id"), "statusUrl": status, "responseUrl": response, "cancelUrl": get("cancel_url") }))
}

async fn get_url(ctx: &Ctx<'_>, raw: &str) -> AppResult<Value> {
    let key = ctx.require_key(NAME)?.to_string();
    let url = Url::parse(raw).map_err(|_| AppError::new(ErrorCode::Provider, "fal.ai returned an invalid status link."))?;
    ctx.net.json(&Req::get(NAME), &url, |c, u| c.get(u.clone()).header("Authorization", format!("Key {key}"))).await
}

/// Picks the 3D model for a quality level: TRELLIS is fast and cheap, Hunyuan3D v2 is the premium option.
fn mesh_request(quality: &str, image: Value, seed: Option<i64>) -> (&'static str, Value) {
    let mut body = if quality == "high" {
        json!({ "input_image_url": image, "textured_mesh": true, "octree_resolution": 384 })
    } else {
        json!({ "image_url": image, "texture_size": if quality == "draft" { 1024 } else { 2048 }, "mesh_simplify": 0.95 })
    };
    if let Some(s) = seed {
        body["seed"] = json!(s);
    }
    (if quality == "high" { HUNYUAN } else { TRELLIS }, body)
}

fn seed(g: &GenerateSpec, variant: u32) -> Option<i64> {
    g.seed.map(|s| s + variant as i64).or(if variant > 0 { Some(rand::random::<u32>() as i64) } else { None })
}

#[async_trait]
impl Provider for Fal {
    fn meta(&self) -> ProviderMeta {
        ProviderMeta {
            id: "fal",
            name: NAME,
            description: "TRELLIS and Hunyuan3D on fal's serverless GPUs — fast and inexpensive.",
            requires_key: true,
            free: false,
            dashboard_url: Some("https://fal.ai/dashboard/keys"),
            docs_url: Some("https://fal.ai/models/fal-ai/trellis/api"),
        }
    }

    fn capabilities(&self, _: &Settings) -> Capabilities {
        Capabilities { text: true, image: true, multiview: true, refine: true, retexture: false, rig: false, negative_prompt: false, face_limit: false, seed: true, pbr: false }
    }

    fn poll_interval(&self) -> Duration {
        Duration::from_secs(2)
    }

    fn expected_duration(&self, _: JobKind) -> Duration {
        Duration::from_secs(60)
    }

    fn estimate_cost(&self, kind: JobKind, spec: Option<&GenerateSpec>, variants: u32, _: Option<f64>) -> CostEstimate {
        let quality = if kind == JobKind::Refine { "high" } else { spec.map(|s| s.quality.as_str()).unwrap_or("standard") };
        let mut usd = if quality == "high" { 0.48 } else { 0.02 };
        if spec.is_some_and(|s| s.mode == "text") && kind == JobKind::Generate {
            usd += 0.003;
        }
        CostEstimate::usd("fal", usd * variants.max(1) as f64, NAME)
    }

    fn check(&self, input: &TaskInput, _: &Settings) -> AppResult<()> {
        match input.spec.kind {
            JobKind::Retexture => Err(unsupported(NAME, "retexture models", "Use Meshy or Tripo for retexturing.")),
            JobKind::Rig => Err(unsupported(NAME, "rig models", "Use Meshy or Tripo for auto-rigging.")),
            JobKind::Refine if input.images.is_empty() && input.source.as_ref().and_then(|s| lineage_str(&s.lineage, "fal", "imageUrl")).is_none() => Err(unsupported(
                NAME,
                "refine this model — the source image isn't available",
                "Generate from an image (or a prompt) with fal.ai, then refine.",
            )),
            _ => Ok(()),
        }
    }

    async fn create_task(&self, ctx: &Ctx<'_>, input: &TaskInput) -> AppResult<Value> {
        let variant = input.spec.variant_index;
        if input.spec.kind == JobKind::Refine {
            let image = match input.images.first() {
                Some(img) => json!(img.data_uri()),
                None => json!(input.source.as_ref().and_then(|s| lineage_str(&s.lineage, "fal", "imageUrl")).unwrap_or_default()),
            };
            let (model, body) = mesh_request("high", image, None);
            let mut h = submit(ctx, model, body).await?;
            h["step"] = json!("mesh");
            return Ok(h);
        }
        let g = input.generate()?;
        match g.mode.as_str() {
            "text" => {
                let mut body = json!({ "prompt": styled_prompt(g, 1500) + ", single object, centered, plain white background", "image_size": "square_hd", "num_inference_steps": 4, "num_images": 1, "output_format": "png" });
                if let Some(s) = seed(g, variant) {
                    body["seed"] = json!(s);
                }
                let mut h = submit(ctx, FLUX, body).await?;
                h["step"] = json!("image");
                h["quality"] = json!(g.quality);
                Ok(h)
            }
            "multiview" => {
                let urls: Vec<String> = input.images.iter().map(ImageInput::data_uri).collect();
                let mut body = json!({ "image_urls": urls, "texture_size": if g.quality == "draft" { 1024 } else { 2048 }, "multiimage_algo": "stochastic" });
                if let Some(s) = seed(g, variant) {
                    body["seed"] = json!(s);
                }
                let mut h = submit(ctx, TRELLIS_MULTI, body).await?;
                h["step"] = json!("mesh");
                Ok(h)
            }
            _ => {
                let img = input.images.first().ok_or_else(|| AppError::new(ErrorCode::Validation, "Add an image first."))?;
                let (model, body) = mesh_request(&g.quality, json!(img.data_uri()), seed(g, variant));
                let mut h = submit(ctx, model, body).await?;
                h["step"] = json!("mesh");
                Ok(h)
            }
        }
    }

    async fn get_status(&self, ctx: &Ctx<'_>, _input: &TaskInput, handle: &mut Value) -> AppResult<Poll> {
        let step = handle["step"].as_str().unwrap_or("mesh").to_string();
        let status_url = handle["statusUrl"].as_str().ok_or_else(|| AppError::internal("Lost the fal.ai status link."))?.to_string();
        let st = get_url(ctx, &status_url).await?;
        let label = if step == "image" { "Drawing a reference image" } else { "Building the 3D model on fal.ai" };
        match st["status"].as_str().unwrap_or_default() {
            "IN_QUEUE" => Ok(Poll::queued(match st["queue_position"].as_i64() {
                Some(n) if n > 0 => format!("Waiting in fal.ai's queue (#{n})"),
                _ => "Waiting in fal.ai's queue".into(),
            })),
            "IN_PROGRESS" => Ok(Poll::running(None, label)),
            "COMPLETED" => {
                if let Some(err) = st.get("error").and_then(Value::as_str) {
                    return Ok(Poll::failed(AppError::new(ErrorCode::Provider, format!("fal.ai: {err}")).with_hint("Retry, or try a different image.")));
                }
                let result = get_url(ctx, handle["responseUrl"].as_str().unwrap_or_default()).await?;
                if step == "image" {
                    let image_url = result["images"][0]["url"].as_str().ok_or_else(|| AppError::new(ErrorCode::Provider, "fal.ai returned no image."))?.to_string();
                    let quality = handle["quality"].as_str().unwrap_or("standard").to_string();
                    let (model, body) = mesh_request(&quality, json!(image_url), None);
                    let mut next = submit(ctx, model, body).await?;
                    next["step"] = json!("mesh");
                    next["imageUrl"] = json!(image_url);
                    *handle = next;
                    return Ok(Poll::running(Some(0.3), "Building the 3D model on fal.ai"));
                }
                let url = result["model_mesh"]["url"].as_str().ok_or_else(|| AppError::new(ErrorCode::Provider, "fal.ai finished but returned no model."))?;
                let mut origin = json!({ "fal": { "model": handle["model"], "requestId": handle["requestId"] } });
                if let Some(img) = handle["imageUrl"].as_str() {
                    origin["fal"]["imageUrl"] = json!(img);
                }
                Ok(Poll::done(ModelSource::Url(url.to_string()), origin))
            }
            other => Ok(Poll::running(None, format!("{label} ({other})"))),
        }
    }

    async fn cancel(&self, ctx: &Ctx<'_>, handle: &Value) -> AppResult<CancelOutcome> {
        let (Some(raw), Some(key)) = (handle["cancelUrl"].as_str(), ctx.key.clone()) else { return Ok(CancelOutcome::LocalOnly) };
        let Ok(url) = Url::parse(raw) else { return Ok(CancelOutcome::LocalOnly) };
        let resp = ctx.net.send(&Req::get(NAME), &url, |c, u| c.put(u.clone()).header("Authorization", format!("Key {key}"))).await?;
        // 200 = removed from the queue; 202 = cancellation requested while running.
        Ok(if resp.status().as_u16() == 200 { CancelOutcome::Cancelled } else { CancelOutcome::LocalOnly })
    }

    async fn test_connection(&self, ctx: &Ctx<'_>) -> AppResult<ConnectionTest> {
        // fal has no balance endpoint; a status lookup for a non-existent request returns
        // 401/403 for a bad key and 404 for a good one — without starting any work.
        let key = ctx.require_key(NAME)?.to_string();
        let url = Url::parse(&format!("{QUEUE}/{TRELLIS}/requests/00000000-0000-0000-0000-000000000000/status")).expect("static URL");
        let start = Instant::now();
        let resp = ctx.net.send(&Req::get(NAME), &url, |c, u| c.get(u.clone()).header("Authorization", format!("Key {key}"))).await?;
        let code = resp.status().as_u16();
        if code == 401 || code == 403 {
            return Err(crate::net::http_error(NAME, resp.status(), None));
        }
        Ok(ConnectionTest { ok: true, latency_ms: Some(start.elapsed().as_millis() as u64), message: "fal.ai accepted your key.".into(), balance: None })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quality_picks_model() {
        assert_eq!(mesh_request("draft", json!("x"), None).0, TRELLIS);
        assert_eq!(mesh_request("high", json!("x"), Some(1)).0, HUNYUAN);
        assert_eq!(mesh_request("high", json!("x"), Some(1)).1["textured_mesh"], true);
        assert_eq!(mesh_request("standard", json!("x"), None).1["texture_size"], 2048);
    }
}
