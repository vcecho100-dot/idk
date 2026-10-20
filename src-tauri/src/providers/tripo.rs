//! Tripo3D v3 REST API (https://openapi.tripo3d.ai/v3), per the official SDKs:
//! `POST /generation/{text|image|multiview}-to-model`, `POST /models/texture`,
//! `POST /animations/{rig-check|rig|retarget}`, `GET /tasks/{id}`, `POST /files`,
//! `GET /account/balance`. Responses use a `{ code, data, message, suggestion }` envelope.

use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde_json::{json, Value};
use url::Url;

use super::*;
use crate::net::Req;

const BASE: &str = "https://openapi.tripo3d.ai/v3";
const NAME: &str = "Tripo";
const MODEL_DEFAULT: &str = "v3.1-20260211";
const MODEL_LOWPOLY: &str = "P1-20260311";

pub struct Tripo;

fn endpoint(path: &str) -> Url {
    Url::parse(&format!("{BASE}{path}")).expect("static URL")
}

/// Unwraps the Tripo envelope, turning `code != 0` into a friendly error.
fn unwrap(env: Value) -> AppResult<Value> {
    let code = env.get("code").and_then(Value::as_i64).unwrap_or(0);
    if code == 0 {
        return env.get("data").cloned().ok_or_else(|| AppError::new(ErrorCode::Provider, "Tripo returned an empty response."));
    }
    let msg = env.get("message").and_then(Value::as_str).unwrap_or("Request failed");
    let suggestion = env.get("suggestion").and_then(Value::as_str);
    let err = match code {
        // 2010 is Tripo's documented "insufficient credit" code. Auth and rate limits
        // arrive as HTTP 401/429 and are mapped by `net::http_error`.
        2010 => AppError::new(ErrorCode::Credits, "Your Tripo account is out of credits.")
            .with_hint("Top up at platform.tripo3d.ai, or switch to the Offline demo or Local GPU."),
        _ =>AppError::new(ErrorCode::Provider, format!("Tripo: {msg}")).with_hint(suggestion.unwrap_or("Adjust the request and try again.").to_string()),
    };
    Err(err)
}

async fn post(ctx: &Ctx<'_>, path: &str, body: Value) -> AppResult<Value> {
    let key = ctx.require_key(NAME)?.to_string();
    let env = ctx.net.json(&Req::create(NAME), &endpoint(path), |c, u| c.post(u.clone()).bearer_auth(&key).json(&body)).await?;
    unwrap(env)
}

async fn get(ctx: &Ctx<'_>, path: &str) -> AppResult<Value> {
    let key = ctx.require_key(NAME)?.to_string();
    let env = ctx.net.json(&Req::get(NAME), &endpoint(path), |c, u| c.get(u.clone()).bearer_auth(&key)).await?;
    unwrap(env)
}

async fn upload(ctx: &Ctx<'_>, img: &ImageInput) -> AppResult<Value> {
    let key = ctx.require_key(NAME)?.to_string();
    let name = format!("{}.{}", img.view.as_deref().unwrap_or("image"), img.ext());
    let env = ctx
        .net
        .json(&Req::create(NAME).with_timeout(Duration::from_secs(180)), &endpoint("/files"), |c, u| {
            let part = reqwest::multipart::Part::bytes(img.bytes.clone()).file_name(name.clone()).mime_str(img.mime).expect("valid mime");
            c.post(u.clone()).bearer_auth(&key).multipart(reqwest::multipart::Form::new().part("file", part))
        })
        .await?;
    let data = unwrap(env)?;
    let token = data.get("file_token").and_then(Value::as_str).ok_or_else(|| AppError::new(ErrorCode::Provider, "Tripo didn't return an upload token."))?;
    Ok(json!({ "file_token": token }))
}

fn quality(q: &str) -> (&'static str, &'static str) {
    match q {
        "draft" => ("standard", "standard"),
        "high" => ("detailed", "detailed"),
        _ => ("detailed", "standard"),
    }
}

/// Shared generation options. Variants get distinct seeds so they actually differ.
fn options(g: &GenerateSpec, variant: u32, force_high: bool) -> Value {
    let model = if g.style == "lowpoly" { MODEL_LOWPOLY } else { MODEL_DEFAULT };
    let (tex_q, geo_q) = quality(if force_high { "high" } else { &g.quality });
    let mut o = json!({ "model": model, "texture": true, "pbr": g.pbr, "texture_quality": tex_q });
    if model != MODEL_LOWPOLY {
        o["geometry_quality"] = json!(geo_q);
    }
    if let Some(f) = g.face_limit {
        o["face_limit"] = json!(f.clamp(500, 300_000));
    }
    let seed = g.seed.unwrap_or_else(|| (rand::random::<u32>() % 1_000_000) as i64) + variant as i64;
    o["model_seed"] = json!(seed);
    o["texture_seed"] = json!(seed);
    o
}

fn merge(mut a: Value, b: Value) -> Value {
    deep_merge(&mut a, &b);
    a
}

async fn submit_generation(ctx: &Ctx<'_>, input: &TaskInput, force_high: bool) -> AppResult<String> {
    let g = input.generate()?;
    let opts = options(g, input.spec.variant_index, force_high);
    let (path, body) = match g.mode.as_str() {
        "image" => {
            let img = input.images.first().ok_or_else(|| AppError::new(ErrorCode::Validation, "Add an image first."))?;
            ("/generation/image-to-model", merge(json!({ "input": upload(ctx, img).await?, "texture_alignment": "original_image" }), opts))
        }
        "multiview" => {
            // Tripo expects [front, left, back, right]; Shift3D's "side" slot maps to left.
            let mut slots = [json!(""), json!(""), json!(""), json!("")];
            for img in &input.images {
                let i = match img.view.as_deref() {
                    Some("side") | Some("left") => 1,
                    Some("back") => 2,
                    Some("right") => 3,
                    _ => 0,
                };
                slots[i] = upload(ctx, img).await?;
            }
            ("/generation/multiview-to-model", merge(json!({ "inputs": slots }), opts))
        }
        _ => {
            let mut body = merge(json!({ "prompt": styled_prompt(g, 1000) }), opts);
            if let Some(n) = g.negative_prompt.as_deref().filter(|n| !n.trim().is_empty()) {
                body["negative_prompt"] = json!(n.chars().take(255).collect::<String>());
            }
            ("/generation/text-to-model", body)
        }
    };
    let data = post(ctx, path, body).await?;
    data.get("task_id").and_then(Value::as_str).map(str::to_string).ok_or_else(|| AppError::new(ErrorCode::Provider, "Tripo didn't return a task id."))
}

fn source_task(input: &TaskInput) -> Option<String> {
    input.source.as_ref().and_then(|s| lineage_str(&s.lineage, "tripo", "taskId")).map(str::to_string)
}

fn animation_preset(animation: &str, rig_type: &str) -> &'static str {
    if rig_type == "quadruped" {
        return "preset:quadruped:walk";
    }
    match animation {
        "walk" => "preset:walk",
        "run" => "preset:run",
        _ => "preset:idle",
    }
}

#[async_trait]
impl Provider for Tripo {
    fn meta(&self) -> ProviderMeta {
        ProviderMeta {
            id: "tripo",
            name: NAME,
            description: "Fast, high-quality text, image and multi-view to 3D, with auto-rigging.",
            requires_key: true,
            free: false,
            dashboard_url: Some("https://platform.tripo3d.ai/"),
            docs_url: Some("https://developers.tripo3d.ai/en/docs/introduction"),
        }
    }

    fn capabilities(&self, _: &Settings) -> Capabilities {
        Capabilities { text: true, image: true, multiview: true, refine: true, retexture: true, rig: true, negative_prompt: true, face_limit: true, seed: true, pbr: true }
    }

    fn poll_interval(&self) -> Duration {
        Duration::from_secs(3)
    }

    fn expected_duration(&self, kind: JobKind) -> Duration {
        Duration::from_secs(match kind {
            JobKind::Generate => 90,
            JobKind::Refine => 150,
            JobKind::Retexture => 60,
            JobKind::Rig => 120,
        })
    }

    fn estimate_cost(&self, kind: JobKind, spec: Option<&GenerateSpec>, variants: u32, history: Option<f64>) -> CostEstimate {
        // Tripo doesn't publish per-task prices; calibrate from the user's own history when we can.
        let base = history.unwrap_or(match kind {
            JobKind::Generate => match spec.map(|s| s.quality.as_str()) {
                Some("draft") => 20.0,
                Some("high") => 40.0,
                _ => 30.0,
            },
            JobKind::Refine => 40.0,
            JobKind::Retexture => 20.0,
            JobKind::Rig => 30.0,
        });
        CostEstimate::credits("tripo", base * variants.max(1) as f64, true, NAME)
    }

    fn check(&self, input: &TaskInput, _: &Settings) -> AppResult<()> {
        match input.spec.kind {
            JobKind::Retexture | JobKind::Rig if source_task(input).is_none() => Err(unsupported(
                NAME,
                if input.spec.kind == JobKind::Rig { "rig models it didn't generate" } else { "retexture models it didn't generate" },
                "Use Meshy (it accepts any GLB), or generate the model with Tripo first.",
            )),
            JobKind::Refine if input.spec.generate.is_none() => Err(unsupported(
                NAME,
                "refine this model — Shift3D doesn't know the prompt or image it came from",
                "Refine works on models generated in Shift3D.",
            )),
            _ => Ok(()),
        }
    }

    async fn create_task(&self, ctx: &Ctx<'_>, input: &TaskInput) -> AppResult<Value> {
        match input.spec.kind {
            JobKind::Generate => Ok(json!({ "step": "model", "taskId": submit_generation(ctx, input, false).await? })),
            JobKind::Refine => Ok(json!({ "step": "model", "taskId": submit_generation(ctx, input, true).await? })),
            JobKind::Retexture => {
                let src = source_task(input).expect("checked");
                let g = input.spec.generate.as_ref();
                let data = post(
                    ctx,
                    "/models/texture",
                    json!({
                        "input": src,
                        "texture": true,
                        "pbr": g.map(|g| g.pbr).unwrap_or(true),
                        "texture_quality": "detailed",
                        "text_prompt": input.spec.texture_prompt.clone().unwrap_or_default().chars().take(1000).collect::<String>(),
                    }),
                )
                .await?;
                Ok(json!({ "step": "model", "taskId": data["task_id"] }))
            }
            JobKind::Rig => {
                let src = source_task(input).expect("checked");
                let data = post(ctx, "/animations/rig-check", json!({ "input": src })).await?;
                Ok(json!({ "step": "check", "taskId": data["task_id"], "modelTaskId": src }))
            }
        }
    }

    async fn get_status(&self, ctx: &Ctx<'_>, input: &TaskInput, handle: &mut Value) -> AppResult<Poll> {
        let task_id = handle["taskId"].as_str().ok_or_else(|| AppError::internal("Lost the Tripo task id."))?.to_string();
        let task = get(ctx, &format!("/tasks/{}", percent_encoding::utf8_percent_encode(&task_id, percent_encoding::NON_ALPHANUMERIC))).await?;
        let status = task["status"].as_str().unwrap_or("unknown");
        let step = handle["step"].as_str().unwrap_or("model").to_string();
        let step_label = match step.as_str() {
            "check" => "Checking the skeleton",
            "rig" => "Rigging on Tripo",
            "retarget" => "Applying animation",
            _ => match input.spec.kind {
                JobKind::Retexture => "Painting textures on Tripo",
                JobKind::Refine => "Refining on Tripo",
                _ => "Generating on Tripo",
            },
        };
        // Multi-step pipelines report progress across their steps.
        let (lo, hi) = match step.as_str() {
            "check" => (0.0, 0.15),
            "rig" => (0.15, 0.6),
            "retarget" => (0.6, 1.0),
            _ => (0.0, 1.0),
        };
        let prog = pct(task.get("progress")).map(|p| lo + p * (hi - lo));
        match status {
            "queued" => {
                let pos = task["queuing_num"].as_i64().filter(|n| *n > 0);
                Ok(Poll::queued(match pos {
                    Some(n) => format!("Waiting in Tripo's queue (#{n})"),
                    None => "Waiting in Tripo's queue".to_string(),
                }))
            }
            "running" => Ok(Poll::running(prog, step_label)),
            "success" => {
                let output = &task["output"];
                match step.as_str() {
                    "check" => {
                        if !output["riggable"].as_bool().unwrap_or(false) {
                            return Ok(Poll::failed(
                                AppError::new(ErrorCode::Provider, "Tripo says this model can't be rigged.").with_hint("Rigging works best on characters and animals in a neutral pose."),
                            ));
                        }
                        let rig_type = output["rig_type"].as_str().unwrap_or("biped").to_string();
                        let data = post(ctx, "/animations/rig", json!({ "input": handle["modelTaskId"], "rig_type": rig_type, "spec": "mixamo", "out_format": "glb" })).await?;
                        *handle = json!({ "step": "rig", "taskId": data["task_id"], "modelTaskId": handle["modelTaskId"], "rigType": rig_type });
                        Ok(Poll::running(Some(0.15), "Rigging on Tripo"))
                    }
                    "rig" => {
                        let preset = animation_preset(input.spec.animation.as_deref().unwrap_or("idle"), handle["rigType"].as_str().unwrap_or("biped"));
                        let data = post(ctx, "/animations/retarget", json!({ "input": task_id, "animation": preset, "out_format": "glb", "bake_animation": true })).await?;
                        *handle = json!({ "step": "retarget", "taskId": data["task_id"], "rigTaskId": task_id, "rigType": handle["rigType"] });
                        Ok(Poll::running(Some(0.6), "Applying animation"))
                    }
                    _ => {
                        let url = output["pbr_model"]
                            .as_str()
                            .filter(|_| input.spec.generate.as_ref().is_some_and(|g| g.pbr))
                            .or_else(|| output["model_url"].as_str())
                            .or_else(|| output["model"].as_str())
                            .or_else(|| output["pbr_model"].as_str())
                            .or_else(|| output["base_model"].as_str())
                            .or_else(|| output["model_urls"].get(0).and_then(Value::as_str))
                            .ok_or_else(|| AppError::new(ErrorCode::Provider, "Tripo finished but didn't return a model."))?;
                        let mut poll = Poll::done(ModelSource::Url(url.to_string()), json!({ "tripo": { "taskId": task_id } }));
                        poll.credits = task["credits_consumed"].as_f64();
                        Ok(poll)
                    }
                }
            }
            "banned" => Ok(Poll::failed(
                AppError::new(ErrorCode::Provider, "Tripo declined this request under its content policy.").with_hint("Rephrase the prompt or use a different image."),
            )),
            "expired" => Ok(Poll::failed(AppError::new(ErrorCode::Provider, "The Tripo task expired.").with_hint("Retry the job."))),
            "failed" | "cancelled" | "unknown" => {
                let msg = task["error_message"].as_str().unwrap_or("Tripo couldn't complete this task");
                Ok(Poll::failed(AppError::new(ErrorCode::Provider, format!("Tripo: {msg}")).with_hint("Retry, or adjust the prompt or image.")))
            }
            other => Ok(Poll::running(prog, format!("{step_label} ({other})"))),
        }
    }

    async fn cancel(&self, _: &Ctx<'_>, _: &Value) -> AppResult<CancelOutcome> {
        // Tripo's v3 API has no cancel endpoint.
        Ok(CancelOutcome::LocalOnly)
    }

    async fn test_connection(&self, ctx: &Ctx<'_>) -> AppResult<ConnectionTest> {
        let start = Instant::now();
        let data = get(ctx, "/account/balance").await?;
        let balance = data["balance"].as_f64().map(|b| format!("{} credits", b.round() as i64));
        Ok(ConnectionTest {
            ok: true,
            latency_ms: Some(start.elapsed().as_millis() as u64),
            message: "Connected to Tripo.".into(),
            balance,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(quality: &str, style: &str) -> GenerateSpec {
        GenerateSpec {
            mode: "text".into(),
            prompt: "a robot".into(),
            negative_prompt: None,
            images: vec![],
            style: style.into(),
            quality: quality.into(),
            face_limit: Some(10_000),
            pbr: true,
            seed: Some(42),
        }
    }

    #[test]
    fn options_follow_quality_and_style() {
        let o = options(&spec("high", "stylized"), 2, false);
        assert_eq!(o["model"], MODEL_DEFAULT);
        assert_eq!(o["geometry_quality"], "detailed");
        assert_eq!(o["model_seed"], 44);
        let low = options(&spec("draft", "lowpoly"), 0, false);
        assert_eq!(low["model"], MODEL_LOWPOLY);
        assert!(low.get("geometry_quality").is_none(), "P1 rejects geometry_quality");
    }

    #[test]
    fn envelope_errors_are_mapped() {
        assert!(unwrap(json!({ "code": 0, "data": { "task_id": "t" } })).is_ok());
        assert_eq!(unwrap(json!({ "code": 2010, "message": "no credit" })).unwrap_err().code, ErrorCode::Credits);
    }

    #[test]
    fn presets() {
        assert_eq!(animation_preset("run", "biped"), "preset:run");
        assert_eq!(animation_preset("run", "quadruped"), "preset:quadruped:walk");
    }
}
