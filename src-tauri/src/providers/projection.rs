//! Image projection texturing — lets 6 GB GPUs produce colored models.
//!
//! Local Hunyuan3D-2mini fits in 6 GB for *shape* generation, but its texture
//! painter needs ~16 GB. Instead, Shift3D projects the input image onto the mesh
//! from the front (the back receives a mirrored copy, like the Model AI prototype).
//! The generator crops the object out of the image before building the shape, so
//! we locate the object's bounding box in the image and map the mesh onto it.

use serde_json::{json, Value};

use crate::error::{AppError, AppResult, ErrorCode};
use crate::glb;

const FLOAT: u64 = 5126;

/// Normalized (u0, v0, u1, v1) rectangle of the object inside the image.
pub fn object_rect(image: &[u8]) -> (f32, f32, f32, f32) {
    let Ok(img) = image::load_from_memory(image) else { return (0.0, 0.0, 1.0, 1.0) };
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    if w < 4 || h < 4 {
        return (0.0, 0.0, 1.0, 1.0);
    }
    let has_alpha = rgba.pixels().any(|p| p.0[3] < 250);
    // Background = average of the four 6x6 corner patches.
    let mut bg = [0f32; 3];
    let mut n = 0f32;
    for (cx, cy) in [(0, 0), (w - 6, 0), (0, h - 6), (w - 6, h - 6)] {
        for y in cy..cy + 6 {
            for x in cx..cx + 6 {
                let p = rgba.get_pixel(x.min(w - 1), y.min(h - 1)).0;
                for i in 0..3 {
                    bg[i] += p[i] as f32;
                }
                n += 1.0;
            }
        }
    }
    bg.iter_mut().for_each(|c| *c /= n);
    let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0u32, 0u32);
    for (x, y, p) in rgba.enumerate_pixels() {
        let fg = if has_alpha {
            p.0[3] > 127
        } else {
            (0..3).map(|i| (p.0[i] as f32 - bg[i]).abs()).sum::<f32>() > 48.0
        };
        if fg {
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
        }
    }
    if x1 <= x0 || y1 <= y0 {
        return (0.0, 0.0, 1.0, 1.0);
    }
    let (fw, fh) = (w as f32, h as f32);
    let area = ((x1 - x0) as f32 * (y1 - y0) as f32) / (fw * fh);
    if area > 0.98 {
        return (0.0, 0.0, 1.0, 1.0);
    }
    (x0 as f32 / fw, y0 as f32 / fh, (x1 + 1) as f32 / fw, (y1 + 1) as f32 / fh)
}

fn read_positions(json: &Value, bin: &[u8], accessor: u64) -> Option<Vec<[f32; 3]>> {
    let acc = json["accessors"].get(accessor as usize)?;
    if acc["componentType"].as_u64()? != FLOAT || acc["type"].as_str()? != "VEC3" {
        return None;
    }
    let view = json["bufferViews"].get(acc["bufferView"].as_u64()? as usize)?;
    let count = acc["count"].as_u64()? as usize;
    let stride = view["byteStride"].as_u64().unwrap_or(12) as usize;
    let start = view["byteOffset"].as_u64().unwrap_or(0) as usize + acc["byteOffset"].as_u64().unwrap_or(0) as usize;
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let o = start + i * stride;
        let f = |k: usize| bin.get(o + k * 4..o + k * 4 + 4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]));
        out.push([f(0)?, f(1)?, f(2)?]);
    }
    Some(out)
}

fn append(bin: &mut Vec<u8>, bytes: &[u8]) -> (usize, usize) {
    while bin.len() % 4 != 0 {
        bin.push(0);
    }
    let offset = bin.len();
    bin.extend_from_slice(bytes);
    (offset, bytes.len())
}

/// Adds front-projected UVs + the image as a base color texture to every primitive.
pub fn project_image(model: &[u8], image: &[u8], mime: &str) -> AppResult<Vec<u8>> {
    let mut g = glb::parse(model)?;
    let rect = object_rect(image);
    let mut bin = g.bin.take().unwrap_or_default();
    let json = &mut g.json;

    // Unique position accessors used by triangle primitives.
    let mut position_accessors: Vec<u64> = Vec::new();
    for mesh in json["meshes"].as_array().cloned().unwrap_or_default() {
        for prim in mesh["primitives"].as_array().cloned().unwrap_or_default() {
            if let Some(p) = prim["attributes"]["POSITION"].as_u64() {
                if !position_accessors.contains(&p) {
                    position_accessors.push(p);
                }
            }
        }
    }
    let mut all = Vec::new();
    for &a in &position_accessors {
        all.push((a, read_positions(json, &bin, a).ok_or_else(|| AppError::new(ErrorCode::Unsupported, "This model's vertex format can't be texture-projected."))?));
    }
    let (mut min, mut max) = ([f32::MAX; 3], [f32::MIN; 3]);
    for (_, ps) in &all {
        for p in ps {
            for i in 0..3 {
                min[i] = min[i].min(p[i]);
                max[i] = max[i].max(p[i]);
            }
        }
    }
    let w = (max[0] - min[0]).max(1e-6);
    let h = (max[1] - min[1]).max(1e-6);
    let (u0, v0, u1, v1) = rect;

    json.as_object_mut().expect("object").entry("bufferViews").or_insert_with(|| json!([]));
    json.as_object_mut().expect("object").entry("accessors").or_insert_with(|| json!([]));
    let mut uv_accessor_for = std::collections::HashMap::new();
    for (a, ps) in &all {
        let mut bytes = Vec::with_capacity(ps.len() * 8);
        for p in ps {
            let u = u0 + (p[0] - min[0]) / w * (u1 - u0);
            let v = v0 + (1.0 - (p[1] - min[1]) / h) * (v1 - v0);
            bytes.extend_from_slice(&u.to_le_bytes());
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        let (offset, len) = append(&mut bin, &bytes);
        let views = json["bufferViews"].as_array_mut().expect("array");
        views.push(json!({ "buffer": 0, "byteOffset": offset, "byteLength": len, "target": 34962 }));
        let view_index = views.len() - 1;
        let accessors = json["accessors"].as_array_mut().expect("array");
        accessors.push(json!({ "bufferView": view_index, "componentType": FLOAT, "count": ps.len(), "type": "VEC2" }));
        uv_accessor_for.insert(*a, accessors.len() - 1);
    }

    let (img_offset, img_len) = append(&mut bin, image);
    let views = json["bufferViews"].as_array_mut().expect("array");
    views.push(json!({ "buffer": 0, "byteOffset": img_offset, "byteLength": img_len }));
    let img_view = views.len() - 1;
    let obj = json.as_object_mut().expect("object");
    let images = obj.entry("images").or_insert_with(|| json!([])).as_array_mut().expect("array");
    images.push(json!({ "bufferView": img_view, "mimeType": mime, "name": "projected" }));
    let image_index = images.len() - 1;
    let samplers = obj.entry("samplers").or_insert_with(|| json!([])).as_array_mut().expect("array");
    samplers.push(json!({ "magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071 }));
    let sampler_index = samplers.len() - 1;
    let textures = obj.entry("textures").or_insert_with(|| json!([])).as_array_mut().expect("array");
    textures.push(json!({ "sampler": sampler_index, "source": image_index }));
    let texture_index = textures.len() - 1;
    let materials = obj.entry("materials").or_insert_with(|| json!([])).as_array_mut().expect("array");
    materials.push(json!({
        "name": "Projected",
        "pbrMetallicRoughness": { "baseColorTexture": { "index": texture_index }, "metallicFactor": 0.0, "roughnessFactor": 0.75 },
        "doubleSided": false
    }));
    let material_index = materials.len() - 1;

    if let Some(meshes) = json["meshes"].as_array_mut() {
        for mesh in meshes {
            if let Some(prims) = mesh["primitives"].as_array_mut() {
                for prim in prims {
                    if let Some(uv) = prim["attributes"]["POSITION"].as_u64().and_then(|p| uv_accessor_for.get(&p)) {
                        prim["attributes"]["TEXCOORD_0"] = json!(uv);
                        prim["material"] = json!(material_index);
                    }
                }
            }
        }
    }

    let obj = json.as_object_mut().expect("object");
    let buffers = obj.entry("buffers").or_insert_with(|| json!([{}])).as_array_mut().expect("array");
    if buffers.is_empty() {
        buffers.push(json!({}));
    }
    while bin.len() % 4 != 0 {
        bin.push(0);
    }
    buffers[0]["byteLength"] = json!(bin.len());
    g.bin = Some(bin);
    Ok(glb::build(&g))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(w: u32, h: u32, f: impl Fn(u32, u32) -> [u8; 4]) -> Vec<u8> {
        let img = image::RgbaImage::from_fn(w, h, |x, y| image::Rgba(f(x, y)));
        let mut out = std::io::Cursor::new(Vec::new());
        img.write_to(&mut out, image::ImageFormat::Png).unwrap();
        out.into_inner()
    }

    #[test]
    fn finds_object_on_plain_background() {
        let img = png(100, 100, |x, y| if (30..70).contains(&x) && (20..90).contains(&y) { [200, 30, 30, 255] } else { [255, 255, 255, 255] });
        let (u0, v0, u1, v1) = object_rect(&img);
        assert!((u0 - 0.30).abs() < 0.02 && (u1 - 0.70).abs() < 0.02);
        assert!((v0 - 0.20).abs() < 0.02 && (v1 - 0.90).abs() < 0.02);
    }

    #[test]
    fn projection_adds_uvs_texture_and_material() {
        let model = crate::glb::tests::triangle_glb();
        let img = png(16, 16, |_, _| [10, 200, 40, 255]);
        let out = project_image(&model, &img, "image/png").unwrap();
        let g = glb::parse(&out).unwrap();
        let prim = &g.json["meshes"][0]["primitives"][0];
        assert!(prim["attributes"]["TEXCOORD_0"].is_u64());
        let mat = &g.json["materials"][prim["material"].as_u64().unwrap() as usize];
        assert!(mat["pbrMetallicRoughness"]["baseColorTexture"].is_object());
        assert_eq!(glb::stats(&out).unwrap().textures, 1);
    }
}
