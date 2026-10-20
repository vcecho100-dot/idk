//! Meshy REST API (https://api.meshy.ai), per docs.meshy.ai:
//! text-to-3d v2 (preview → refine), image-to-3d v1, multi-image-to-3d v1,
//! retexture v1, rigging v1, animations v1, balance v1. Images and models are
//! sent as data URIs, so nothing has to be hosted publicly.

use std::time::{Duration, Instant};

use async_trait::async_trait;
use base64::Engine;
use serde_json::{json, Value};
use url::Url;

use super::*;
use crate::net::Req;

const BASE: &str = "https://api.meshy.ai";
const NAME: &str = "Meshy";

pub struct Meshy;

fn endpoint(path: &str) -> Url {
    Url::parse(&format!("{BASE}{path}")).expect("static URL")
}

fn status_path(api: &str, id: &str) -> String {
    let id = percent_encoding::utf8_percent_encode(id, percent_encoding::NON_ALPHANUMERIC).to_string();
    match api {
        "text-to-3d" => format!("/openapi/v2/text-to-3d/{id}"),
        "image-to-3d" => format!("/openapi/v1/image-to-3d/{id}"),
        "multi-image-to-3d" => format!("/openapi/v1/multi-image-to-3d/{id}"),
        "retexture" => format!("/openapi/v1/retexture/{id}"),
        "rigging" => format!("/openapi/v1/rigging/{id}"),
        _ => format!("/openapi/v1/animations/{id}"),
    }
}

async fn post(ctx: &Ctx<'_>, path: &str, body: Value) -> AppResult<String> {
    let key = ctx.require_key(NAME)?.to_string();
    let resp = ctx
        .net
        .json(&Req::create(NAME).with_timeout(Duration::from_secs(240)), &endpoint(path), |c, u| c.post(u.clone()).bearer_auth(&key).json(&body))
        .await?;
    resp.get("result").and_then(Value::as_str).map(str::to_string).ok_or_else(|| AppError::new(ErrorCode::Provider, "Meshy didn't return a task id."))
}

async fn get(ctx: &Ctx<'_>, path: &str) -> AppResult<Value> {
    let key = ctx.require_key(NAME)?.to_string();
    ctx.net.json(&Req::get(NAME), &endpoint(path), |c, u| c.get(u.clone()).bearer_auth(&key)).await
}

fn glb_data_uri(bytes: &[u8]) -> AppResult<String> {
    if bytes.len() > 100 * 1024 * 1024 {
        return Err(AppError::new(ErrorCode::Validation, "Meshy accepts uploaded models up to 100 MB.").with_hint("Optimize the model first (Tools → Optimize)."));
    }
    Ok(format!("data:application/octet-stream;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

fn mesh_options(g: &GenerateSpec, high: bool) -> Value {
    let mut o = json!({ "ai_model": "latest", "topology": "triangle" });
    if let Some(f) = g.face_limit {
        o["should_remesh"] = json!(true);
        o["target_polycount"] = json!(f.clamp(100, 300_000));
    }
    if high {
        o["geometry_resolution"] = json!("2k");
    }
    o
}

fn texture_resolution(q: &str) -> &'static str {
    if q == "high" {
        "4k"
    } else {
        "2k"
    }
}

async fn submit_generation(ctx: &Ctx<'_>, input: &TaskInput, high: bool) -> AppResult<Value> {
    let g = input.generate()?;
    let quality = if high { "high" } else { g.quality.as_str() };
    let textured = quality != "draft";
    match g.mode.as_str() {
        "text" => {
            let mut body = mesh_options(g, high);
            body["mode"] = json!("preview");
            body["prompt"] = json!(styled_prompt(g, 800));
            let id = post(ctx, "/openapi/v2/text-to-3d", body).await?;
            Ok(json!({ "api": "text-to-3d", "step": "preview", "taskId": id, "previewId": id, "wantRefine": textured, "pbr": g.pbr, "quality": quality }))
        }
        mode => {
            let mut body = mesh_options(g, high);
            body["should_texture"] = json!(textured);
            body["enable_pbr"] = json!(textured && g.pbr);
            if textured {
                body["texture_resolution"] = json!(texture_resolution(quality));
            }
            let (api, path) = if mode == "multiview" {
                // Meshy treats the first image as the primary front view.
                let mut imgs: Vec<&ImageInput> = input.images.iter().collect();
                imgs.sort_by_key(|i| match i.view.as_deref() {
                    Some("front") | None => 0,
                    Some("side") | Some("left") => 1,
                    Some("back") => 2,
                    _ => 3,
                });
                body["image_urls"] = json!(imgs.iter().take(4).map(|i| i.data_uri()).collect::<Vec<_>>());
                ("multi-image-to-3d", "/openapi/v1/multi-image-to-3d")
            } else {
                let img = input.images.first().ok_or_else(|| AppError::new(ErrorCode::Validation, "Add an image first."))?;
                body["image_url"] = json!(img.data_uri());
                ("image-to-3d", "/openapi/v1/image-to-3d")
            };
            let id = post(ctx, path, body).await?;
            Ok(json!({ "api": api, "taskId": id, "textured": textured }))
        }
    }
}

fn lineage(input: &TaskInput) -> Option<&Value> {
    input.source.as_ref().and_then(|s| s.lineage.get("meshy"))
}

/// Finds an array of `{ action_id, name }` objects in a library response of unknown nesting.
fn first_action(v: &Value) -> Option<i64> {
    match v {
        Value::Array(items) => items.iter().find_map(|i| i.get("action_id").and_then(Value::as_i64)),
        Value::Object(o) => o.values().find_map(first_action),
        _ => None,
    }
}

#[async_trait]
impl Provider for Meshy {
    fn meta(&self) -> ProviderMeta {
        ProviderMeta {
            id: "meshy",
            name: NAME,
            description: "Text, image and multi-image to 3D, with retexturing and humanoid rigging.",
            requires_key: true,
            free: false,
            dashboard_url: Some("https://www.meshy.ai/settings/api"),
            docs_url: Some("https://docs.meshy.ai/"),
        }
    }

    fn capabilities(&self, _: &Settings) -> Capabilities {
        Capabilities { text: true, image: true, multiview: true, refine: true, retexture: true, rig: true, negative_prompt: false, face_limit: true, seed: false, pbr: true }
    }

    fn poll_interval(&self) -> Duration {
        Duration::from_secs(3)
    }

    fn expected_duration(&self, kind: JobKind) -> Duration {
        Duration::from_secs(match kind {
            JobKind::Generate => 120,
            JobKind::Refine => 90,
            JobKind::Retexture => 90,
            JobKind::Rig => 90,
        })
    }

    fn estimate_cost(&self, kind: JobKind, spec: Option<&GenerateSpec>, variants: u32, _: Option<f64>) -> CostEstimate {
        // Published Meshy pricing (meshy-7.1 / latest).
        let per = match kind {
            JobKind::Generate => match spec {
                Some(g) if g.quality == "draft" => 20.0,
                Some(g) if g.quality == "high" => 35.0,
                _ => 30.0,
            },
            JobKind::Refine => 10.0,
            JobKind::Retexture => 10.0,
            JobKind::Rig => 8.0,
        };
        CostEstimate::credits("meshy", per * variants.max(1) as f64, false, NAME)
    }

    fn check(&self, input: &TaskInput, _: &Settings) -> AppResult<()> {
        if input.spec.kind == JobKind::Refine && lineage(input).is_none() && input.spec.generate.is_none() {
            return Err(unsupported(NAME, "refine this model — Shift3D doesn't know where it came from", "Use Retexture to repaint it instead."));
        }
        Ok(())
    }

    async fn create_task(&self, ctx: &Ctx<'_>, input: &TaskInput) -> AppResult<Value> {
        match input.spec.kind {
            JobKind::Generate => submit_generation(ctx, input, false).await,
            JobKind::Refine => {
                let lin = lineage(input).cloned().unwrap_or(Value::Null);
                let textured = lin["textured"].as_bool().unwrap_or(true);
                let api = lin["api"].as_str().unwrap_or_default();
                let pbr = input.spec.generate.as_ref().map(|g| g.pbr).unwrap_or(true);
                if api == "text-to-3d" && !textured {
                    let preview = lin["previewId"].as_str().or(lin["taskId"].as_str()).unwrap_or_default();
                    let id = post(ctx, "/openapi/v2/text-to-3d", json!({ "mode": "refine", "preview_task_id": preview, "enable_pbr": pbr, "texture_resolution": "4k" })).await?;
                    return Ok(json!({ "api": "text-to-3d", "step": "refine", "taskId": id, "previewId": preview }));
                }
                if (api == "image-to-3d" || api == "multi-image-to-3d") && !textured {
                    let style = input.images.first().map(|i| i.data_uri());
                    let mut body = json!({ "input_task_id": lin["taskId"], "enable_pbr": pbr, "enable_original_uv": true, "ai_model": "latest" });
                    match style {
                        Some(uri) => body["image_style_url"] = json!(uri),
                        None => body["text_style_prompt"] = json!("high quality, detailed PBR textures"),
                    }
                    let id = post(ctx, "/openapi/v1/retexture", body).await?;
                    return Ok(json!({ "api": "retexture", "taskId": id, "textured": true }));
                }
                // Already textured (or from elsewhere): regenerate at the highest settings.
                submit_generation(ctx, input, true).await
            }
            JobKind::Retexture => {
                let prompt: String = input.spec.texture_prompt.clone().unwrap_or_default().chars().take(800).collect();
                let pbr = input.spec.generate.as_ref().map(|g| g.pbr).unwrap_or(true);
                let mut body = json!({ "text_style_prompt": prompt, "enable_pbr": pbr, "enable_original_uv": true, "ai_model": "latest" });
                match lineage(input).and_then(|l| l["taskId"].as_str()).filter(|_| lineage(input).is_some_and(|l| l["api"] != "rigging")) {
                    Some(task) => body["input_task_id"] = json!(task),
                    None => body["model_url"] = json!(glb_data_uri(&input.source.as_ref().expect("source").bytes)?),
                }
                let id = post(ctx, "/openapi/v1/retexture", body).await?;
                Ok(json!({ "api": "retexture", "taskId": id, "textured": true }))
            }
            JobKind::Rig => {
                let mut body = json!({ "height_meters": 1.7 });
                match lineage(input).and_then(|l| l["taskId"].as_str()) {
                    Some(task) if lineage(input).is_some_and(|l| l["textured"].as_bool().unwrap_or(true)) => body["input_task_id"] = json!(task),
                    _ => body["model_url"] = json!(glb_data_uri(&input.source.as_ref().expect("source").bytes)?),
                }
                let id = post(ctx, "/openapi/v1/rigging", body).await?;
                Ok(json!({ "api": "rigging", "step": "rig", "taskId": id }))
            }
        }
    }

    async fn get_status(&self, ctx: &Ctx<'_>, input: &TaskInput, handle: &mut Value) -> AppResult<Poll> {
        let api = handle["api"].as_str().unwrap_or_default().to_string();
        let step = handle["step"].as_str().unwrap_or_default().to_string();
        let id = handle["taskId"].as_str().ok_or_else(|| AppError::internal("Lost the Meshy task id."))?.to_string();
        let task = get(ctx, &status_path(if step == "animation" { "animations" } else { &api }, &id)).await?;
        let raw = pct(task.get("progress"));
        // Two-step flows split the bar so it never jumps backwards.
        let (lo, hi) = match (api.as_str(), step.as_str()) {
            ("text-to-3d", "preview") if handle["wantRefine"].as_bool().unwrap_or(false) => (0.0, 0.6),
            ("text-to-3d", "refine") if handle.get("fromPreview").is_some() => (0.6, 1.0),
            ("rigging", "rig") if input.spec.animation.as_deref() == Some("idle") => (0.0, 0.7),
            ("rigging", "animation") => (0.7, 1.0),
            _ => (0.0, 1.0),
        };
        let progress = raw.map(|p| lo + p * (hi - lo));
        let label = match (api.as_str(), step.as_str()) {
            ("text-to-3d", "preview") => "Sculpting the shape on Meshy",
            ("text-to-3d", "refine") => "Painting textures on Meshy",
            ("retexture", _) => "Painting textures on Meshy",
            ("rigging", "rig") => "Rigging on Meshy",
            ("rigging", "animation") => "Applying animation",
            _ => "Generating on Meshy",
        };
        match task["status"].as_str().unwrap_or_default() {
            "PENDING" => Ok(Poll::queued("Waiting in Meshy's queue")),
            "IN_PROGRESS" => Ok(Poll::running(progress, label)),
            "SUCCEEDED" => {
                if api == "text-to-3d" && step == "preview" && handle["wantRefine"].as_bool().unwrap_or(false) {
                    let refine = post(
                        ctx,
                        "/openapi/v2/text-to-3d",
                        json!({
                            "mode": "refine",
                            "preview_task_id": id,
                            "enable_pbr": handle["pbr"].as_bool().unwrap_or(true),
                            "texture_resolution": texture_resolution(handle["quality"].as_str().unwrap_or("standard")),
                        }),
                    )
                    .await?;
                    *handle = json!({ "api": "text-to-3d", "step": "refine", "taskId": refine, "previewId": id, "fromPreview": true });
                    return Ok(Poll::running(Some(0.6), "Painting textures on Meshy"));
                }
                if api == "rigging" && step == "rig" {
                    let result = &task["result"];
                    let anim = input.spec.animation.as_deref().unwrap_or("idle");
                    let basic = &result["basic_animations"];
                    let url = match anim {
                        "walk" => basic["walking_glb_url"].as_str(),
                        "run" => basic["running_glb_url"].as_str(),
                        _ => None,
                    };
                    if let Some(url) = url {
                        return Ok(Poll::done(ModelSource::Url(url.to_string()), json!({ "meshy": { "api": "rigging", "taskId": id, "textured": true } })));
                    }
                    // Idle isn't part of the basic set: look it up in Meshy's animation library.
                    let library = get(ctx, "/openapi/v1/animations/library?search=idle").await.ok();
                    if let Some(action) = library.as_ref().and_then(first_action) {
                        let anim_id = post(ctx, "/openapi/v1/animations", json!({ "rig_task_id": id, "action_id": action })).await?;
                        *handle = json!({ "api": "rigging", "step": "animation", "taskId": anim_id, "rigTaskId": id });
                        return Ok(Poll::running(Some(0.7), "Applying animation"));
                    }
                    let url = result["rigged_character_glb_url"].as_str().ok_or_else(|| AppError::new(ErrorCode::Provider, "Meshy finished rigging but returned no model."))?;
                    return Ok(Poll::done(ModelSource::Url(url.to_string()), json!({ "meshy": { "api": "rigging", "taskId": id, "textured": true } })));
                }
                if step == "animation" {
                    let url = task["result"]["animation_glb_url"].as_str().ok_or_else(|| AppError::new(ErrorCode::Provider, "Meshy returned no animation file."))?;
                    return Ok(Poll::done(ModelSource::Url(url.to_string()), json!({ "meshy": { "api": "rigging", "taskId": handle["rigTaskId"], "textured": true } })));
                }
                let url = task["model_urls"]["glb"].as_str().ok_or_else(|| AppError::new(ErrorCode::Provider, "Meshy finished but returned no GLB."))?;
                let textured = match api.as_str() {
                    "text-to-3d" => step == "refine",
                    _ => handle["textured"].as_bool().unwrap_or(true),
                };
                let mut origin = json!({ "meshy": { "api": api, "taskId": id, "textured": textured } });
                if api == "text-to-3d" {
                    origin["meshy"]["previewId"] = handle["previewId"].clone();
                }
                let mut poll = Poll::done(ModelSource::Url(url.to_string()), origin);
                poll.credits = task["consumed_credits"].as_f64();
                Ok(poll)
            }
            "CANCELED" => Ok(Poll::failed(AppError::new(ErrorCode::Cancelled, "The task was canceled on Meshy."))),
            "FAILED" => {
                let msg = task["task_error"]["message"].as_str().filter(|m| !m.is_empty()).unwrap_or("Meshy couldn't complete this task");
                Ok(Poll::failed(AppError::new(ErrorCode::Provider, format!("Meshy: {msg}")).with_hint("Retry, or adjust the prompt or image.")))
            }
            other => Ok(Poll::running(progress, format!("{label} ({other})"))),
        }
    }

    async fn cancel(&self, ctx: &Ctx<'_>, handle: &Value) -> AppResult<CancelOutcome> {
        // Only pending text-to-3d tasks can be deleted (and refunded); running ones return 409.
        if handle["api"] == "text-to-3d" {
            if let (Some(id), Some(key)) = (handle["taskId"].as_str(), ctx.key.clone()) {
                let url = endpoint(&status_path("text-to-3d", id));
                if let Ok(resp) = ctx.net.send(&Req::get(NAME), &url, |c, u| c.delete(u.clone()).bearer_auth(&key)).await {
                    if resp.status().is_success() {
                        return Ok(CancelOutcome::Cancelled);
                    }
                }
            }
        }
        Ok(CancelOutcome::LocalOnly)
    }

    async fn test_connection(&self, ctx: &Ctx<'_>) -> AppResult<ConnectionTest> {
        let start = Instant::now();
        let data = get(ctx, "/openapi/v1/balance").await?;
        Ok(ConnectionTest {
            ok: true,
            latency_ms: Some(start.elapsed().as_millis() as u64),
            message: "Connected to Meshy.".into(),
            balance: data["balance"].as_f64().map(|b| format!("{} credits", b as i64)),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_action_ids_in_any_shape() {
        assert_eq!(first_action(&json!([{ "action_id": 12, "name": "Idle" }])), Some(12));
        assert_eq!(first_action(&json!({ "result": { "items": [{ "action_id": 7 }] } })), Some(7));
        assert_eq!(first_action(&json!({ "result": [] })), None);
    }

    #[test]
    fn status_paths() {
        assert_eq!(status_path("text-to-3d", "abc"), "/openapi/v2/text-to-3d/abc");
        assert_eq!(status_path("rigging", "a/b"), "/openapi/v1/rigging/a%2Fb");
    }
}
