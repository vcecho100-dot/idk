//! The offline demo provider (default with no key). It fakes realistic staged
//! progress over ~8 seconds, then returns a bundled sample model picked by
//! keyword — the same catalog and rules as the web engine (`src/lib/engine/catalog.ts`).

use std::sync::OnceLock;
use std::time::Duration;

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};

use super::*;
use crate::glb::{self, MaterialEdit};

const CATALOG_JSON: &str = include_str!("../../samples/catalog.json");

fn sample_file(file: &str) -> Option<&'static [u8]> {
    Some(match file {
        "Fox.glb" => include_bytes!("../../samples/Fox.glb"),
        "CesiumMan.glb" => include_bytes!("../../samples/CesiumMan.glb"),
        "Duck.glb" => include_bytes!("../../samples/Duck.glb"),
        "CesiumMilkTruck.glb" => include_bytes!("../../samples/CesiumMilkTruck.glb"),
        "TrafficCone.glb" => include_bytes!("../../samples/TrafficCone.glb"),
        "SheenChair.glb" => include_bytes!("../../samples/SheenChair.glb"),
        "Sword.glb" => include_bytes!("../../samples/Sword.glb"),
        "House.glb" => include_bytes!("../../samples/House.glb"),
        "Robot.glb" => include_bytes!("../../samples/Robot.glb"),
        "Tree.glb" => include_bytes!("../../samples/Tree.glb"),
        "Crystal.glb" => include_bytes!("../../samples/Crystal.glb"),
        _ => return None,
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub id: String,
    pub file: String,
    pub keywords: Vec<String>,
    #[serde(default)]
    pub rigged: bool,
}

#[derive(Debug, Deserialize)]
pub struct Catalog {
    pub samples: Vec<Sample>,
    pub defaults: Vec<String>,
}

pub fn catalog() -> &'static Catalog {
    static C: OnceLock<Catalog> = OnceLock::new();
    C.get_or_init(|| serde_json::from_str(CATALOG_JSON).expect("embedded catalog is valid"))
}

pub fn fnv1a(text: &str) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    // Match JS `charCodeAt` (UTF-16 code units) so both engines hash identically.
    for unit in text.encode_utf16() {
        h ^= unit as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

pub fn tokenize(text: &str) -> Vec<String> {
    text.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() || c.is_whitespace() || c == '-' { c } else { ' ' })
        .collect::<String>()
        .split(|c: char| c.is_whitespace() || c == '_' || c == '-')
        .filter(|w| w.chars().count() > 1)
        .map(str::to_string)
        .collect()
}

fn singular(w: &str) -> String {
    if w.len() > 4 && w.ends_with("ies") {
        return format!("{}y", &w[..w.len() - 3]);
    }
    if w.len() > 3 && (w.ends_with("ches") || w.ends_with("shes") || w.ends_with("xes") || w.ends_with("ses")) {
        return w[..w.len() - 2].to_string();
    }
    if w.len() > 3 && w.ends_with('s') && !w.ends_with("ss") {
        return w[..w.len() - 1].to_string();
    }
    w.to_string()
}

pub fn pick_sample(text: &str) -> &'static Sample {
    let cat = catalog();
    let words: Vec<String> = tokenize(text).iter().map(|w| singular(w)).collect();
    let mut best: Option<&Sample> = None;
    let mut best_score = 0;
    for s in &cat.samples {
        let mut score = 0;
        for w in &words {
            for kw in &s.keywords {
                if w == kw {
                    score += 3;
                } else if w.len() >= 4 && (kw.starts_with(w.as_str()) || w.starts_with(kw.as_str())) {
                    score += 1;
                }
            }
        }
        if score > best_score {
            best = Some(s);
            best_score = score;
        }
    }
    if let Some(b) = best {
        return b;
    }
    let pool: Vec<&Sample> = cat.defaults.iter().filter_map(|id| cat.samples.iter().find(|s| &s.id == id)).collect();
    let key = text.trim().to_lowercase();
    pool[(fnv1a(&key) as usize) % pool.len()]
}

pub fn sample_by_id(id: &str) -> Option<&'static Sample> {
    catalog().samples.iter().find(|s| s.id == id)
}

pub fn sample_bytes(s: &Sample) -> AppResult<Vec<u8>> {
    sample_file(&s.file).map(<[u8]>::to_vec).ok_or_else(|| AppError::internal(format!("Bundled sample {} is missing.", s.file)))
}

pub const VARIANT_TINTS: [[f64; 3]; 4] = [[1.0, 1.0, 1.0], [1.0, 0.8, 0.62], [0.66, 0.84, 1.0], [0.8, 1.0, 0.72]];

const COLORS: &[(&str, [f64; 3])] = &[
    ("red", [1.0, 0.22, 0.2]),
    ("crimson", [0.85, 0.12, 0.18]),
    ("orange", [1.0, 0.55, 0.2]),
    ("yellow", [1.0, 0.9, 0.3]),
    ("gold", [1.0, 0.76, 0.33]),
    ("golden", [1.0, 0.76, 0.33]),
    ("green", [0.35, 0.85, 0.4]),
    ("emerald", [0.2, 0.8, 0.5]),
    ("teal", [0.2, 0.8, 0.75]),
    ("cyan", [0.3, 0.9, 1.0]),
    ("blue", [0.3, 0.5, 1.0]),
    ("navy", [0.2, 0.25, 0.6]),
    ("purple", [0.65, 0.4, 1.0]),
    ("violet", [0.6, 0.4, 1.0]),
    ("pink", [1.0, 0.5, 0.75]),
    ("white", [1.3, 1.3, 1.3]),
    ("black", [0.18, 0.18, 0.2]),
    ("grey", [0.6, 0.6, 0.62]),
    ("gray", [0.6, 0.6, 0.62]),
    ("silver", [0.9, 0.92, 0.95]),
    ("bronze", [0.8, 0.5, 0.25]),
    ("copper", [0.95, 0.55, 0.38]),
    ("brown", [0.6, 0.4, 0.25]),
    ("wooden", [0.75, 0.5, 0.3]),
    ("wood", [0.75, 0.5, 0.3]),
    ("rusty", [0.75, 0.38, 0.2]),
    ("rust", [0.75, 0.38, 0.2]),
    ("marble", [1.15, 1.12, 1.08]),
    ("stone", [0.7, 0.7, 0.68]),
    ("ice", [0.75, 0.92, 1.1]),
    ("icy", [0.75, 0.92, 1.1]),
    ("lava", [1.0, 0.35, 0.15]),
    ("candy", [1.0, 0.6, 0.85]),
];

/// (word, metallic, roughness, emissive)
const SURFACES: &[(&str, Option<f64>, Option<f64>, bool)] = &[
    ("metal", Some(1.0), Some(0.3), false),
    ("metallic", Some(1.0), Some(0.3), false),
    ("chrome", Some(1.0), Some(0.08), false),
    ("steel", Some(1.0), Some(0.32), false),
    ("gold", Some(1.0), Some(0.25), false),
    ("golden", Some(1.0), Some(0.25), false),
    ("silver", Some(1.0), Some(0.2), false),
    ("bronze", Some(1.0), Some(0.4), false),
    ("copper", Some(1.0), Some(0.35), false),
    ("wood", Some(0.0), Some(0.85), false),
    ("wooden", Some(0.0), Some(0.85), false),
    ("stone", Some(0.0), Some(0.95), false),
    ("marble", Some(0.0), Some(0.25), false),
    ("plastic", Some(0.0), Some(0.45), false),
    ("rubber", Some(0.0), Some(0.9), false),
    ("matte", None, Some(1.0), false),
    ("glossy", None, Some(0.12), false),
    ("shiny", None, Some(0.15), false),
    ("polished", None, Some(0.1), false),
    ("rusty", Some(0.4), Some(1.0), false),
    ("ice", Some(0.0), Some(0.1), false),
    ("icy", Some(0.0), Some(0.1), false),
    ("neon", None, Some(0.3), true),
    ("glowing", None, None, true),
    ("glow", None, None, true),
    ("lava", None, Some(0.9), true),
    ("magic", None, None, true),
];

fn hsl_to_rgb(h: f64, s: f64, l: f64) -> [f64; 3] {
    let k = |n: f64| (n + h * 12.0) % 12.0;
    let a = s * l.min(1.0 - l);
    let f = |n: f64| l - a * (-1f64).max((k(n) - 3.0).min((9.0 - k(n)).min(1.0)));
    [f(0.0) * 1.6, f(8.0) * 1.6, f(4.0) * 1.6]
}

pub fn material_edit_from_prompt(prompt: &str) -> MaterialEdit {
    let mut e = MaterialEdit::default();
    for w in tokenize(prompt) {
        if e.tint.is_none() {
            if let Some((_, c)) = COLORS.iter().find(|(k, _)| *k == w) {
                e.tint = Some(*c);
                e.matched.push(w.clone());
            }
        }
        if let Some((_, metal, rough, emissive)) = SURFACES.iter().find(|(k, ..)| *k == w) {
            if metal.is_some() {
                e.metallic = *metal;
            }
            if rough.is_some() {
                e.roughness = *rough;
            }
            if *emissive {
                e.emissive = Some([0.6, 0.6, 0.6]);
            }
            if !e.matched.contains(&w) {
                e.matched.push(w.clone());
            }
        }
    }
    if let (Some(_), Some(t)) = (e.emissive, e.tint) {
        e.emissive = Some(t.map(|c| (c * 0.7).min(1.0)));
    }
    if e.tint.is_none() && e.metallic.is_none() && e.roughness.is_none() && e.emissive.is_none() {
        let hue = (fnv1a(&prompt.to_lowercase()) % 360) as f64 / 360.0;
        e.tint = Some(hsl_to_rgb(hue, 0.55, 0.62));
    }
    e
}

const GENERATE_STAGES: &[(f64, &str)] =
    &[(0.08, "Reading your prompt"), (0.5, "Sculpting the shape"), (0.8, "Painting textures"), (0.93, "Cleaning up topology"), (1.0, "Downloading model")];
const REFINE_STAGES: &[(f64, &str)] = &[(0.1, "Preparing draft"), (0.6, "Adding geometric detail"), (0.9, "Baking PBR maps"), (1.0, "Downloading model")];
const RETEXTURE_STAGES: &[(f64, &str)] = &[(0.1, "Unwrapping UVs"), (0.75, "Painting new textures"), (1.0, "Downloading model")];
const RIG_STAGES: &[(f64, &str)] = &[(0.2, "Detecting skeleton"), (0.6, "Skinning mesh"), (0.9, "Retargeting animation"), (1.0, "Downloading model")];

fn stage(kind: JobKind, p: f64) -> &'static str {
    let table = match kind {
        JobKind::Generate => GENERATE_STAGES,
        JobKind::Refine => REFINE_STAGES,
        JobKind::Retexture => RETEXTURE_STAGES,
        JobKind::Rig => RIG_STAGES,
    };
    table.iter().find(|(until, _)| p <= *until).map(|(_, l)| *l).unwrap_or("Downloading model")
}

fn duration_ms(kind: JobKind) -> i64 {
    match kind {
        JobKind::Generate => 8000,
        JobKind::Refine => 6500,
        JobKind::Retexture => 5500,
        JobKind::Rig => 5000,
    }
}

fn source_sample(input: &TaskInput) -> Option<(&'static Sample, u32)> {
    let lineage = &input.source.as_ref()?.lineage;
    let id = lineage.get("sampleId").and_then(Value::as_str)?;
    let variant = lineage.get("variant").and_then(Value::as_u64).unwrap_or(0) as u32;
    sample_by_id(id).map(|s| (s, variant))
}

pub struct Mock;

#[async_trait]
impl Provider for Mock {
    fn meta(&self) -> ProviderMeta {
        ProviderMeta {
            id: "mock",
            name: "Offline demo",
            description: "Simulated generation with bundled sample models. No account, no internet.",
            requires_key: false,
            free: true,
            dashboard_url: None,
            docs_url: None,
        }
    }

    fn capabilities(&self, _: &Settings) -> Capabilities {
        Capabilities { text: true, image: true, multiview: true, refine: true, retexture: true, rig: true, negative_prompt: true, face_limit: true, seed: true, pbr: true }
    }

    fn poll_interval(&self) -> Duration {
        Duration::from_millis(120)
    }

    fn expected_duration(&self, kind: JobKind) -> Duration {
        Duration::from_millis(duration_ms(kind) as u64)
    }

    fn estimate_cost(&self, _: JobKind, _: Option<&GenerateSpec>, _: u32, _: Option<f64>) -> CostEstimate {
        CostEstimate::free("mock", "Free · offline demo")
    }

    fn check(&self, input: &TaskInput, _: &Settings) -> AppResult<()> {
        match input.spec.kind {
            JobKind::Refine if source_sample(input).is_none() => Err(unsupported(
                "The offline demo",
                "refine models it didn't generate",
                "Connect Tripo or Meshy in Settings to refine any model.",
            )),
            JobKind::Rig if !source_sample(input).is_some_and(|(s, _)| s.rigged) => Err(unsupported(
                "The offline demo",
                "rig this model — it only rigs its humanoid and quadruped samples",
                "Try a prompt like “a knight” or “a fox”, or connect Tripo or Meshy to rig any model.",
            )),
            _ => Ok(()),
        }
    }

    async fn create_task(&self, _: &Ctx<'_>, input: &TaskInput) -> AppResult<Value> {
        let jitter = (rand::random::<u32>() % 1500) as i64 - 400;
        let mut handle = json!({ "startedMs": now_ms(), "durationMs": duration_ms(input.spec.kind) + jitter });
        if let Some(g) = &input.spec.generate {
            let names: Vec<&str> = input.images.iter().map(|i| i.name.as_str()).collect();
            let sample = pick_sample(&format!("{} {}", g.prompt, names.join(" ")));
            handle["sampleId"] = json!(sample.id);
        }
        Ok(handle)
    }

    async fn get_status(&self, _: &Ctx<'_>, input: &TaskInput, handle: &mut Value) -> AppResult<Poll> {
        let started = handle["startedMs"].as_i64().unwrap_or_else(now_ms);
        let total = handle["durationMs"].as_i64().unwrap_or(8000).max(1) as f64;
        let t = ((now_ms() - started) as f64 / total).clamp(0.0, 1.0);
        let p = (1.0 - (1.0 - t).powf(1.7)).min(0.999);
        if t < 1.0 {
            return Ok(Poll::running(Some(p), stage(input.spec.kind, p)));
        }
        let kind = input.spec.kind;
        let (bytes, origin) = match kind {
            JobKind::Generate => {
                let g = input.generate()?;
                let s = handle["sampleId"].as_str().and_then(sample_by_id).ok_or_else(|| AppError::internal("Sample missing."))?;
                let mut b = sample_bytes(s)?;
                let v = input.spec.variant_index;
                if v > 0 {
                    b = glb::tint(&b, VARIANT_TINTS[(v as usize) % VARIANT_TINTS.len()], 0.85)?;
                }
                if g.quality == "draft" {
                    b = glb::draft(&b)?;
                }
                (b, json!({ "sampleId": s.id, "variant": v, "quality": g.quality }))
            }
            JobKind::Refine => {
                let (s, variant) = source_sample(input).ok_or_else(|| AppError::internal("Sample missing."))?;
                let mut b = sample_bytes(s)?;
                if variant > 0 {
                    b = glb::tint(&b, VARIANT_TINTS[(variant as usize) % VARIANT_TINTS.len()], 0.85)?;
                }
                (b, json!({ "sampleId": s.id, "variant": variant, "quality": "high" }))
            }
            JobKind::Retexture => {
                let src = input.source.as_ref().ok_or_else(|| AppError::internal("Source missing."))?;
                let prompt = input.spec.texture_prompt.clone().unwrap_or_default();
                let edit = material_edit_from_prompt(&prompt);
                (glb::apply_material_edit(&src.bytes, &edit)?, json!({ "texturePrompt": prompt, "matched": edit.matched }))
            }
            JobKind::Rig => {
                let (s, _) = source_sample(input).ok_or_else(|| AppError::internal("Sample missing."))?;
                (sample_bytes(s)?, json!({ "sampleId": s.id, "animation": input.spec.animation }))
            }
        };
        Ok(Poll::done(ModelSource::Bytes(bytes), origin))
    }

    async fn cancel(&self, _: &Ctx<'_>, _: &Value) -> AppResult<CancelOutcome> {
        Ok(CancelOutcome::Cancelled)
    }

    async fn test_connection(&self, _: &Ctx<'_>) -> AppResult<ConnectionTest> {
        Ok(ConnectionTest { ok: true, latency_ms: Some(0), message: "The offline demo is always available.".into(), balance: None })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_files_all_exist_and_are_valid_glbs() {
        for s in &catalog().samples {
            let bytes = sample_bytes(s).unwrap();
            let stats = glb::stats(&bytes).unwrap_or_else(|e| panic!("{}: {}", s.file, e.message));
            assert!(stats.triangles > 0, "{} has no triangles", s.file);
        }
    }

    #[test]
    fn keyword_picking_matches_web_engine_rules() {
        assert_eq!(pick_sample("a cute fox").id, "fox");
        assert_eq!(pick_sample("Medieval knights in armor").id, "cesium-man");
        assert_eq!(pick_sample("an enchanted sword with a gold hilt").id, "sword");
        assert_eq!(pick_sample("cozy cottages").id, "house");
        assert_eq!(pick_sample("a delivery truck").id, "milk-truck");
        // Unknown prompts are deterministic.
        assert_eq!(pick_sample("zzzz qqqq").id, pick_sample("zzzz qqqq").id);
    }

    #[test]
    fn fnv_matches_js() {
        // Known FNV-1a 32-bit values (same as the TypeScript implementation).
        assert_eq!(fnv1a(""), 0x811c9dc5);
        assert_eq!(fnv1a("a"), 0xe40c292c);
    }

    #[test]
    fn retexture_words() {
        let e = material_edit_from_prompt("red rusty metal");
        assert_eq!(e.tint, Some([1.0, 0.22, 0.2]));
        assert_eq!(e.metallic, Some(1.0));
        assert!(e.matched.contains(&"metal".to_string()));
        let unknown = material_edit_from_prompt("zorblax");
        assert!(unknown.tint.is_some());
    }
}
