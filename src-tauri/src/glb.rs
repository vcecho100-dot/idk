//! GLB container handling: validation, statistics and lightweight material edits.
//! Mirrors `src/lib/gltf/glb.ts` so both engines agree on stats and mock edits.

use serde_json::{json, Value};

use crate::db::ModelStats;
use crate::error::{AppError, AppResult, ErrorCode};

const MAGIC: u32 = 0x4654_6c67; // "glTF"
const CHUNK_JSON: u32 = 0x4e4f_534a;
const CHUNK_BIN: u32 = 0x004e_4942;

/// Hard ceiling for any model entering the library.
pub const MAX_MODEL_BYTES: u64 = 256 * 1024 * 1024;
/// Hard ceiling for a GLB's JSON chunk (protects serde from pathological input).
const MAX_JSON_BYTES: usize = 64 * 1024 * 1024;

pub struct Glb {
    pub json: Value,
    pub bin: Option<Vec<u8>>,
}

fn invalid(msg: &str) -> AppError {
    AppError::new(ErrorCode::Validation, format!("This isn't a valid GLB model: {msg}."))
        .with_hint("Re-export it as binary glTF (.glb) and try again.")
}

fn u32_at(b: &[u8], o: usize) -> Option<u32> {
    b.get(o..o + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

pub fn is_glb(bytes: &[u8]) -> bool {
    u32_at(bytes, 0) == Some(MAGIC)
}

pub fn parse(bytes: &[u8]) -> AppResult<Glb> {
    if bytes.len() as u64 > MAX_MODEL_BYTES {
        return Err(AppError::new(ErrorCode::Validation, "That model is larger than 256 MB.")
            .with_hint("Decimate or compress it in your 3D tool first."));
    }
    if bytes.len() < 20 || !is_glb(bytes) {
        return Err(invalid("missing glTF header"));
    }
    if u32_at(bytes, 4) != Some(2) {
        return Err(invalid("unsupported container version"));
    }
    let length = u32_at(bytes, 8).unwrap_or(0) as usize;
    if length > bytes.len() || length < 20 {
        return Err(invalid("the file is truncated"));
    }
    let mut offset = 12;
    let mut json: Option<Value> = None;
    let mut bin: Option<Vec<u8>> = None;
    while offset + 8 <= length {
        let chunk_len = u32_at(bytes, offset).unwrap_or(0) as usize;
        let chunk_type = u32_at(bytes, offset + 4).unwrap_or(0);
        offset += 8;
        let end = offset.checked_add(chunk_len).filter(|e| *e <= length).ok_or_else(|| invalid("a chunk overruns the file"))?;
        let data = &bytes[offset..end];
        match chunk_type {
            CHUNK_JSON if json.is_none() => {
                if data.len() > MAX_JSON_BYTES {
                    return Err(invalid("the JSON chunk is too large"));
                }
                json = Some(serde_json::from_slice(data).map_err(|_| invalid("the JSON chunk is corrupt"))?);
            }
            CHUNK_BIN if bin.is_none() => bin = Some(data.to_vec()),
            _ => {}
        }
        offset = end;
    }
    let json = json.ok_or_else(|| invalid("no JSON chunk"))?;
    if !json.get("asset").and_then(|a| a.get("version")).and_then(Value::as_str).is_some_and(|v| v.starts_with('2')) {
        return Err(invalid("not glTF 2.0"));
    }
    Ok(Glb { json, bin })
}

pub fn build(glb: &Glb) -> Vec<u8> {
    let json_bytes = serde_json::to_vec(&glb.json).unwrap_or_default();
    let json_len = (json_bytes.len() + 3) & !3;
    let bin_len = glb.bin.as_ref().map(|b| (b.len() + 3) & !3).unwrap_or(0);
    let total = 12 + 8 + json_len + if glb.bin.is_some() { 8 + bin_len } else { 0 };
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&MAGIC.to_le_bytes());
    out.extend_from_slice(&2u32.to_le_bytes());
    out.extend_from_slice(&(total as u32).to_le_bytes());
    out.extend_from_slice(&(json_len as u32).to_le_bytes());
    out.extend_from_slice(&CHUNK_JSON.to_le_bytes());
    out.extend_from_slice(&json_bytes);
    out.resize(20 + json_len, b' ');
    if let Some(bin) = &glb.bin {
        out.extend_from_slice(&(bin_len as u32).to_le_bytes());
        out.extend_from_slice(&CHUNK_BIN.to_le_bytes());
        out.extend_from_slice(bin);
        out.resize(total, 0);
    }
    out
}

/// Width/height from PNG, JPEG or WebP headers.
pub fn image_size(d: &[u8]) -> Option<(u32, u32)> {
    let be16 = |o: usize| d.get(o..o + 2).map(|s| u16::from_be_bytes([s[0], s[1]]) as u32);
    let be32 = |o: usize| d.get(o..o + 4).map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]));
    let le16 = |o: usize| d.get(o..o + 2).map(|s| u16::from_le_bytes([s[0], s[1]]) as u32);
    let le32 = |o: usize| d.get(o..o + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]));
    if d.len() >= 24 && d[..4] == [0x89, b'P', b'N', b'G'] {
        return Some((be32(16)?, be32(20)?));
    }
    if d.len() > 4 && d[0] == 0xff && d[1] == 0xd8 {
        let mut o = 2;
        while o + 9 < d.len() {
            if d[o] != 0xff {
                o += 1;
                continue;
            }
            let marker = d[o + 1];
            if (0xc0..=0xcf).contains(&marker) && marker != 0xc4 && marker != 0xc8 && marker != 0xcc {
                return Some((be16(o + 7)?, be16(o + 5)?));
            }
            o += 2 + be16(o + 2)? as usize;
        }
        return None;
    }
    if d.len() >= 30 && &d[..4] == b"RIFF" && &d[8..12] == b"WEBP" {
        return match &d[12..16] {
            b"VP8X" => Some((1 + (le32(24)? & 0xff_ffff), 1 + (le32(27)? & 0xff_ffff))),
            b"VP8 " => Some((le16(26)? & 0x3fff, le16(28)? & 0x3fff)),
            b"VP8L" => {
                let b = le32(21)?;
                Some(((b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1))
            }
            _ => None,
        };
    }
    None
}

pub fn image_mime(d: &[u8]) -> Option<&'static str> {
    if d.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some("image/png")
    } else if d.starts_with(&[0xff, 0xd8]) {
        Some("image/jpeg")
    } else if d.len() >= 12 && &d[..4] == b"RIFF" && &d[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

#[cfg(test)]
pub fn stats(bytes: &[u8]) -> AppResult<ModelStats> {
    let glb = parse(bytes)?;
    Ok(stats_of(&glb, bytes.len() as u64))
}

pub fn stats_of(glb: &Glb, file_size: u64) -> ModelStats {
    let j = &glb.json;
    let accessors = j.get("accessors").and_then(Value::as_array).cloned().unwrap_or_default();
    let count = |i: u64| accessors.get(i as usize).and_then(|a| a.get("count")).and_then(Value::as_u64).unwrap_or(0);
    let mut triangles = 0u64;
    let mut vertex_accessors = std::collections::BTreeSet::new();
    for mesh in j.get("meshes").and_then(Value::as_array).into_iter().flatten() {
        for prim in mesh.get("primitives").and_then(Value::as_array).into_iter().flatten() {
            let mode = prim.get("mode").and_then(Value::as_u64).unwrap_or(4);
            let pos = prim.get("attributes").and_then(|a| a.get("POSITION")).and_then(Value::as_u64);
            if let Some(p) = pos {
                vertex_accessors.insert(p);
            }
            let n = match prim.get("indices").and_then(Value::as_u64) {
                Some(i) => count(i),
                None => pos.map(count).unwrap_or(0),
            };
            triangles += match mode {
                4 => n / 3,
                5 | 6 => n.saturating_sub(2),
                _ => 0,
            };
        }
    }
    let vertices = vertex_accessors.iter().map(|a| count(*a)).sum();
    let mut max_texture_size = 0u64;
    if let Some(bin) = &glb.bin {
        let views = j.get("bufferViews").and_then(Value::as_array).cloned().unwrap_or_default();
        for img in j.get("images").and_then(Value::as_array).into_iter().flatten() {
            let Some(view) = img.get("bufferView").and_then(Value::as_u64).and_then(|i| views.get(i as usize)) else { continue };
            let start = view.get("byteOffset").and_then(Value::as_u64).unwrap_or(0) as usize;
            let len = view.get("byteLength").and_then(Value::as_u64).unwrap_or(0) as usize;
            let end = (start + len.min(64 * 1024)).min(bin.len());
            if start < end {
                if let Some((w, h)) = image_size(&bin[start..end]) {
                    max_texture_size = max_texture_size.max(w.max(h) as u64);
                }
            }
        }
    }
    let len_of = |k: &str| j.get(k).and_then(Value::as_array).map(|a| a.len() as u64).unwrap_or(0);
    ModelStats {
        triangles,
        vertices,
        materials: len_of("materials"),
        textures: len_of("textures"),
        max_texture_size,
        file_size,
        animations: j
            .get("animations")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .enumerate()
                    .map(|(i, x)| x.get("name").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string).unwrap_or(format!("Animation {}", i + 1)))
                    .collect()
            })
            .unwrap_or_default(),
        has_skin: len_of("skins") > 0,
    }
}

/* ------------------------------ Material edits ------------------------------ */

fn edit_materials(bytes: &[u8], mut f: impl FnMut(&mut serde_json::Map<String, Value>)) -> AppResult<Vec<u8>> {
    let mut glb = parse(bytes)?;
    if let Some(mats) = glb.json.get_mut("materials").and_then(Value::as_array_mut) {
        for m in mats.iter_mut() {
            if let Some(obj) = m.as_object_mut() {
                f(obj);
            }
        }
    }
    Ok(build(&glb))
}

fn pbr(m: &mut serde_json::Map<String, Value>) -> &mut serde_json::Map<String, Value> {
    m.entry("pbrMetallicRoughness").or_insert_with(|| json!({})).as_object_mut().expect("pbr is an object")
}

fn base_color(p: &serde_json::Map<String, Value>) -> [f64; 4] {
    let mut c = [1.0; 4];
    if let Some(arr) = p.get("baseColorFactor").and_then(Value::as_array) {
        for (i, v) in arr.iter().take(4).enumerate() {
            c[i] = v.as_f64().unwrap_or(1.0);
        }
    }
    c
}

pub fn tint(bytes: &[u8], t: [f64; 3], strength: f64) -> AppResult<Vec<u8>> {
    edit_materials(bytes, |m| {
        let p = pbr(m);
        let [r, g, b, a] = base_color(p);
        let mix = |c: f64, t: f64| c * (1.0 - strength + strength * t);
        p.insert("baseColorFactor".into(), json!([mix(r, t[0]), mix(g, t[1]), mix(b, t[2]), a]));
    })
}

pub fn draft(bytes: &[u8]) -> AppResult<Vec<u8>> {
    edit_materials(bytes, |m| {
        m.remove("normalTexture");
        m.remove("occlusionTexture");
        if let Some(p) = m.get_mut("pbrMetallicRoughness").and_then(Value::as_object_mut) {
            p.remove("metallicRoughnessTexture");
            let rough = p.get("roughnessFactor").and_then(Value::as_f64).unwrap_or(1.0).max(0.85);
            p.insert("roughnessFactor".into(), json!(rough));
        }
    })
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct MaterialEdit {
    pub tint: Option<[f64; 3]>,
    pub metallic: Option<f64>,
    pub roughness: Option<f64>,
    pub emissive: Option<[f64; 3]>,
    pub matched: Vec<String>,
}

pub fn apply_material_edit(bytes: &[u8], e: &MaterialEdit) -> AppResult<Vec<u8>> {
    edit_materials(bytes, |m| {
        let p = pbr(m);
        if let Some(t) = e.tint {
            let [r, g, b, a] = base_color(p);
            let blend = |c: f64, t: f64| (c * 0.25 + t * 0.75 * c + 0.08 * t).min(1.0);
            p.insert("baseColorFactor".into(), json!([blend(r, t[0]), blend(g, t[1]), blend(b, t[2]), a]));
        }
        if let Some(metal) = e.metallic {
            p.insert("metallicFactor".into(), json!(metal));
            p.remove("metallicRoughnessTexture");
        }
        if let Some(r) = e.roughness {
            p.insert("roughnessFactor".into(), json!(r));
        }
        let base_tex = p.get("baseColorTexture").cloned();
        if let Some(em) = e.emissive {
            m.insert("emissiveFactor".into(), json!(em));
            if let Some(tex) = base_tex {
                m.entry("emissiveTexture").or_insert(tex);
            }
        }
    })
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A tiny valid GLB: one triangle, one material, one animation-less mesh.
    pub fn triangle_glb() -> Vec<u8> {
        let mut bin = Vec::new();
        for f in [0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0] {
            bin.extend_from_slice(&f.to_le_bytes());
        }
        let json = json!({
            "asset": { "version": "2.0" },
            "buffers": [{ "byteLength": 36 }],
            "bufferViews": [{ "buffer": 0, "byteLength": 36 }],
            "accessors": [{ "bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3", "min": [0,0,0], "max": [1,1,0] }],
            "materials": [{ "pbrMetallicRoughness": { "baseColorFactor": [1, 1, 1, 1] }, "normalTexture": { "index": 0 } }],
            "meshes": [{ "primitives": [{ "attributes": { "POSITION": 0 }, "material": 0 }] }],
            "nodes": [{ "mesh": 0 }],
            "scenes": [{ "nodes": [0] }],
            "scene": 0
        });
        build(&Glb { json, bin: Some(bin) })
    }

    #[test]
    fn roundtrip_and_stats() {
        let bytes = triangle_glb();
        assert!(is_glb(&bytes));
        assert_eq!(bytes.len() % 4, 0);
        let s = stats(&bytes).unwrap();
        assert_eq!(s.triangles, 1);
        assert_eq!(s.vertices, 3);
        assert_eq!(s.materials, 1);
        assert!(!s.has_skin);
    }

    #[test]
    fn rejects_garbage_and_truncation() {
        assert!(parse(b"not a model at all, definitely").is_err());
        let mut bytes = triangle_glb();
        bytes.truncate(bytes.len() - 10);
        assert!(parse(&bytes).is_err());
        // Header that lies about chunk length.
        let mut evil = triangle_glb();
        evil[12..16].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(parse(&evil).is_err());
    }

    #[test]
    fn edits_change_materials() {
        let bytes = triangle_glb();
        let drafted = parse(&draft(&bytes).unwrap()).unwrap();
        assert!(drafted.json["materials"][0].get("normalTexture").is_none());
        let tinted = parse(&tint(&bytes, [1.0, 0.5, 0.5], 1.0).unwrap()).unwrap();
        assert_eq!(tinted.json["materials"][0]["pbrMetallicRoughness"]["baseColorFactor"][1], json!(0.5));
        let edit = MaterialEdit { metallic: Some(1.0), roughness: Some(0.2), ..Default::default() };
        let edited = parse(&apply_material_edit(&bytes, &edit).unwrap()).unwrap();
        assert_eq!(edited.json["materials"][0]["pbrMetallicRoughness"]["metallicFactor"], json!(1.0));
    }

    #[test]
    fn image_headers() {
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];
        png.extend_from_slice(&512u32.to_be_bytes());
        png.extend_from_slice(&256u32.to_be_bytes());
        assert_eq!(image_size(&png), Some((512, 256)));
        assert_eq!(image_mime(&png), Some("image/png"));
        assert_eq!(image_size(b"GIF89a......"), None);
    }
}
