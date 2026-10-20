//! Everything that touches user files. Native dialogs run in Rust, and the webview
//! only ever receives opaque ids/tokens — never a path it could reuse.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::ipc::Request;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::db::now;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::glb;
use crate::library::{self, raw_request, NewVersionMeta, VersionExtra};
use crate::paths::{is_within, safe_file_stem, safe_id};
use crate::settings::write_atomic;
use crate::state::{new_id, AppState, StagedImage};

pub const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_PROJECT_FILE_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_ZIP_ENTRIES: usize = 4000;
const MAX_ZIP_TOTAL: u64 = 2 * 1024 * 1024 * 1024;
const MAX_ZIP_RATIO: u64 = 200;

fn protocol_base() -> &'static str {
    if cfg!(windows) {
        "http://s3d.localhost"
    } else {
        "s3d://localhost"
    }
}

/* --------------------------------- Images --------------------------------- */

pub fn stage_bytes(st: &AppState, name: &str, bytes: &[u8]) -> AppResult<StagedImage> {
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(AppError::new(ErrorCode::Validation, format!("{name} is larger than 20 MB.")).with_hint("Use a smaller PNG, JPEG or WebP image."));
    }
    glb::image_mime(bytes).ok_or_else(|| AppError::new(ErrorCode::Validation, format!("{name} isn't a PNG, JPEG or WebP image.")))?;
    let (width, height) = glb::image_size(bytes).ok_or_else(|| AppError::new(ErrorCode::Validation, format!("{name} looks corrupt.")))?;
    if width < 64 || height < 64 || width > 8192 || height > 8192 {
        return Err(AppError::new(ErrorCode::Validation, format!("{name} is {width}×{height}.")).with_hint("Use an image between 64 and 8192 pixels on each side."));
    }
    let id = new_id("img_");
    write_atomic(&st.paths.staged_image(&id)?, bytes)?;
    let img = StagedImage {
        url: format!("{}/staged/{id}", protocol_base()),
        id,
        name: name.chars().filter(|c| !c.is_control()).take(120).collect(),
        size: bytes.len() as u64,
        width,
        height,
    };
    st.add_staged(img.clone());
    Ok(img)
}

fn read_limited(path: &Path, max: u64) -> AppResult<Vec<u8>> {
    let meta = std::fs::metadata(path)?;
    if !meta.is_file() {
        return Err(AppError::new(ErrorCode::Validation, "That isn't a file."));
    }
    if meta.len() > max {
        return Err(AppError::new(ErrorCode::Validation, format!("That file is larger than {} MB.", max / (1024 * 1024))));
    }
    let mut buf = Vec::with_capacity(meta.len() as usize);
    std::fs::File::open(path)?.take(max + 1).read_to_end(&mut buf)?;
    if buf.len() as u64 > max {
        return Err(AppError::new(ErrorCode::Validation, "That file is too large."));
    }
    Ok(buf)
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| AppError::internal(e.to_string()))
}

#[tauri::command]
pub async fn pick_images<R: Runtime>(app: AppHandle<R>, multiple: bool) -> AppResult<Vec<StagedImage>> {
    let dialog = app.dialog().file().set_title("Choose an image").add_filter("Images", &["png", "jpg", "jpeg", "webp"]);
    let picked: Vec<PathBuf> = blocking(move || {
        if multiple {
            dialog.blocking_pick_files().unwrap_or_default().into_iter().filter_map(|p| p.into_path().ok()).collect()
        } else {
            dialog.blocking_pick_file().and_then(|p| p.into_path().ok()).into_iter().collect()
        }
    })
    .await?;
    let st = app.state::<AppState>();
    picked.iter().take(4).map(|p| stage_bytes(&st, &file_name(p), &read_limited(p, MAX_IMAGE_BYTES)?)).collect()
}

#[derive(Deserialize)]
struct NameMeta {
    name: String,
}

#[tauri::command]
pub async fn stage_image_bytes<R: Runtime>(app: AppHandle<R>, request: Request<'_>) -> AppResult<StagedImage> {
    let (bytes, meta): (Vec<u8>, NameMeta) = raw_request(&request)?;
    stage_bytes(&app.state::<AppState>(), &meta.name, &bytes)
}

/* ------------------------------ Drop & launch ------------------------------ */

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DroppedFile {
    pub token: String,
    pub name: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Rejected {
    pub name: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct DroppedItems {
    pub images: Vec<StagedImage>,
    pub models: Vec<DroppedFile>,
    pub projects: Vec<DroppedFile>,
    pub rejected: Vec<Rejected>,
}

impl DroppedItems {
    pub fn is_empty(&self) -> bool {
        self.images.is_empty() && self.models.is_empty() && self.projects.is_empty() && self.rejected.is_empty()
    }
}

/// Turns paths the user dropped or opened with Shift3D into staged images and grant tokens.
pub fn classify(st: &AppState, paths: &[PathBuf]) -> DroppedItems {
    let mut out = DroppedItems::default();
    for p in paths.iter().take(32) {
        let name = file_name(p);
        let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        let size = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
        let result: AppResult<()> = (|| {
            match ext.as_str() {
                "png" | "jpg" | "jpeg" | "webp" => out.images.push(stage_bytes(st, &name, &read_limited(p, MAX_IMAGE_BYTES)?)?),
                "glb" | "gltf" => out.models.push(DroppedFile { token: st.grant(p.clone()), name: name.clone(), size }),
                "shift3d" => out.projects.push(DroppedFile { token: st.grant(p.clone()), name: name.clone(), size }),
                _ => return Err(AppError::new(ErrorCode::Unsupported, "Unsupported file type")),
            }
            Ok(())
        })();
        if let Err(e) = result {
            out.rejected.push(Rejected { name, reason: e.message });
        }
    }
    out
}

pub fn emit_dropped<R: Runtime>(app: &AppHandle<R>, items: DroppedItems) {
    if !items.is_empty() {
        let _ = app.emit("app://dropped", items);
    }
}

/* ---------------------------------- glTF ---------------------------------- */

/// Packs a .gltf (with data: URIs or sibling files) into a single GLB.
pub fn gltf_to_glb(gltf_path: &Path) -> AppResult<Vec<u8>> {
    let text = read_limited(gltf_path, 64 * 1024 * 1024)?;
    let mut json: Value = serde_json::from_slice(&text).map_err(|_| AppError::new(ErrorCode::Validation, "That .gltf file isn't valid JSON."))?;
    let dir = gltf_path.parent().ok_or_else(|| AppError::new(ErrorCode::Validation, "Invalid file location."))?.to_path_buf();
    let resolve = |uri: &str| -> AppResult<Vec<u8>> {
        if let Some(rest) = uri.strip_prefix("data:") {
            let (_, data) = rest.split_once(";base64,").ok_or_else(|| AppError::new(ErrorCode::Validation, "Unsupported data URI in .gltf."))?;
            return base64::engine::general_purpose::STANDARD.decode(data).map_err(|_| AppError::new(ErrorCode::Validation, "Corrupt data URI in .gltf."));
        }
        let decoded = percent_encoding::percent_decode_str(uri).decode_utf8_lossy().to_string();
        let rel = Path::new(&decoded);
        // Only plain relative paths next to the .gltf — no absolute paths, drives or `..`.
        if rel.is_absolute() || rel.components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
            return Err(AppError::new(ErrorCode::Validation, "The .gltf references a file outside its folder.").with_hint("Keep .bin and textures next to the .gltf."));
        }
        let full = dir.join(rel);
        if !is_within(&dir, &full) {
            return Err(AppError::new(ErrorCode::Validation, "The .gltf references a file outside its folder."));
        }
        read_limited(&full, glb::MAX_MODEL_BYTES).map_err(|_| AppError::new(ErrorCode::NotFound, format!("Missing file referenced by the .gltf: {decoded}")).with_hint("Keep .bin and textures next to the .gltf."))
    };

    let mut bin: Vec<u8> = Vec::new();
    let mut buffer_offsets = Vec::new();
    for buf in json["buffers"].as_array().cloned().unwrap_or_default() {
        while bin.len() % 8 != 0 {
            bin.push(0);
        }
        buffer_offsets.push(bin.len());
        let uri = buf["uri"].as_str().ok_or_else(|| AppError::new(ErrorCode::Validation, "A .gltf buffer has no data."))?;
        bin.extend_from_slice(&resolve(uri)?);
        if bin.len() as u64 > glb::MAX_MODEL_BYTES {
            return Err(AppError::new(ErrorCode::Validation, "That model is larger than 256 MB."));
        }
    }
    if let Some(views) = json["bufferViews"].as_array_mut() {
        for v in views {
            let b = v["buffer"].as_u64().unwrap_or(0) as usize;
            let base = *buffer_offsets.get(b).ok_or_else(|| AppError::new(ErrorCode::Validation, "Invalid buffer reference in .gltf."))?;
            v["buffer"] = json!(0);
            v["byteOffset"] = json!(v["byteOffset"].as_u64().unwrap_or(0) as usize + base);
        }
    }
    let images = json["images"].as_array().cloned().unwrap_or_default();
    for (i, img) in images.iter().enumerate() {
        let Some(uri) = img["uri"].as_str() else { continue };
        let bytes = resolve(uri)?;
        let mime = glb::image_mime(&bytes).unwrap_or("image/png");
        while bin.len() % 4 != 0 {
            bin.push(0);
        }
        let views = json.as_object_mut().expect("object").entry("bufferViews").or_insert_with(|| json!([])).as_array_mut().expect("array");
        views.push(json!({ "buffer": 0, "byteOffset": bin.len(), "byteLength": bytes.len() }));
        let view_index = views.len() - 1;
        bin.extend_from_slice(&bytes);
        let image = &mut json["images"][i];
        image.as_object_mut().expect("object").remove("uri");
        image["bufferView"] = json!(view_index);
        image["mimeType"] = json!(mime);
    }
    while bin.len() % 4 != 0 {
        bin.push(0);
    }
    let has_bin = !bin.is_empty();
    json["buffers"] = if has_bin { json!([{ "byteLength": bin.len() }]) } else { json!([]) };
    let out = glb::build(&glb::Glb { json, bin: has_bin.then_some(bin) });
    glb::parse(&out)?;
    Ok(out)
}

fn import_model_path<R: Runtime>(app: &AppHandle<R>, st: &AppState, path: &Path) -> AppResult<String> {
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let bytes = match ext.as_str() {
        "glb" => read_limited(path, glb::MAX_MODEL_BYTES)?,
        "gltf" => gltf_to_glb(path)?,
        _ => return Err(AppError::new(ErrorCode::Unsupported, "Shift3D opens .glb, .gltf and .shift3d files.")),
    };
    glb::parse(&bytes)?;
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Imported model".into());
    let project = library::create_project(st, &stem, "", None, None)?;
    library::add_version(
        app,
        st,
        NewVersionMeta { project_id: project.id.clone(), parent_id: None, kind: "import".into(), label: "Imported".into(), params: json!({ "file": file_name(path) }) },
        &bytes,
        VersionExtra::default(),
    )?;
    Ok(project.id)
}

#[tauri::command]
pub async fn import_model<R: Runtime>(app: AppHandle<R>, token: Option<String>) -> AppResult<Option<String>> {
    let path = match token {
        Some(t) => app.state::<AppState>().take_grant(&t)?.path,
        None => {
            let dialog = app.dialog().file().set_title("Open a 3D model").add_filter("glTF models", &["glb", "gltf"]);
            match blocking(move || dialog.blocking_pick_file().and_then(|p| p.into_path().ok())).await? {
                Some(p) => p,
                None => return Ok(None),
            }
        }
    };
    let app2 = app.clone();
    blocking(move || {
        let st = app2.state::<AppState>();
        import_model_path(&app2, &st, &path)
    })
    .await?
    .map(Some)
}

/* ------------------------------ .shift3d files ------------------------------ */

#[derive(Deserialize)]
struct ProjectFileManifest {
    project: crate::db::Project,
    versions: Vec<crate::db::Version>,
}

fn zip_err(e: zip::result::ZipError) -> AppError {
    AppError::new(ErrorCode::Validation, format!("That project file is damaged: {e}"))
}

/// Archive entries as (allowlisted name, bytes).
pub type ArchiveFiles = Vec<(String, Vec<u8>)>;

/// Reads a .shift3d archive with zip-bomb protection: entry count, per-entry and total
/// size caps enforced on the *actual* decompressed bytes, a compression-ratio limit,
/// and a strict allowlist of entry names (no paths are ever taken from the archive).
pub fn read_project_archive(bytes: &[u8]) -> AppResult<(Value, ArchiveFiles)> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(zip_err)?;
    if archive.len() > MAX_ZIP_ENTRIES {
        return Err(AppError::new(ErrorCode::Validation, "That project file has too many entries."));
    }
    let mut manifest = None;
    let mut files = Vec::new();
    let mut total = 0u64;
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(zip_err)?;
        // Entries with invalid names are skipped, like any other non-allowlisted entry.
        let Ok(name) = entry.name().map(|n| n.to_string()) else { continue };
        let allowed = name == "project.json"
            || name.strip_prefix("versions/").and_then(|n| n.strip_suffix(".glb")).is_some_and(|id| safe_id(id).is_ok())
            || name.strip_prefix("thumbs/").and_then(|n| n.strip_suffix(".webp")).is_some_and(|id| safe_id(id).is_ok());
        if !allowed || entry.is_dir() {
            continue;
        }
        let limit = if name == "project.json" { 16 * 1024 * 1024 } else { glb::MAX_MODEL_BYTES };
        let compressed = entry.compressed_size().max(1);
        let mut buf = Vec::new();
        entry.take(limit + 1).read_to_end(&mut buf).map_err(|_| AppError::new(ErrorCode::Validation, "That project file is damaged."))?;
        let size = buf.len() as u64;
        if size > limit || (size > 10 * 1024 * 1024 && size / compressed > MAX_ZIP_RATIO) {
            return Err(AppError::new(ErrorCode::Validation, "That project file expands to an unsafe size.").with_hint("It may be corrupted or malicious."));
        }
        total += size;
        if total > MAX_ZIP_TOTAL {
            return Err(AppError::new(ErrorCode::Validation, "That project file expands to more than 2 GB.").with_hint("It may be corrupted or malicious."));
        }
        if name == "project.json" {
            manifest = Some(serde_json::from_slice::<Value>(&buf).map_err(|_| AppError::new(ErrorCode::Validation, "The project manifest is corrupt."))?);
        } else {
            files.push((name, buf));
        }
    }
    let manifest = manifest.ok_or_else(|| AppError::new(ErrorCode::Validation, "That isn't a Shift3D project file (no manifest)."))?;
    Ok((manifest, files))
}

fn import_project_archive<R: Runtime>(app: &AppHandle<R>, st: &AppState, bytes: &[u8]) -> AppResult<String> {
    let (manifest, files) = read_project_archive(bytes)?;
    let data: ProjectFileManifest = serde_json::from_value(manifest).map_err(|_| AppError::new(ErrorCode::Validation, "The project manifest is from an unsupported version."))?;
    let find = |name: String| files.iter().find(|(n, _)| *n == name).map(|(_, b)| b.clone());
    let mut project = library::create_project(st, &data.project.name, &data.project.prompt, data.project.style.clone(), data.project.provider.clone())?;
    project.tags = data.project.tags.clone();
    project.favorite = data.project.favorite;
    st.db.update_project(&project)?;
    let mut versions = data.versions;
    versions.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    let mut id_map = std::collections::HashMap::new();
    for v in versions {
        let Some(model) = find(format!("versions/{}.glb", v.id)) else { continue };
        let created = library::add_version(
            app,
            st,
            NewVersionMeta {
                project_id: project.id.clone(),
                parent_id: v.parent_id.as_ref().and_then(|p| id_map.get(p).cloned()),
                kind: v.kind.clone(),
                label: v.label.clone(),
                params: v.params.clone(),
            },
            &model,
            VersionExtra {
                provider: v.provider.clone(),
                variant_group: v.variant_group.clone(),
                variant_index: v.variant_index,
                make_current: Some(data.project.current_version_id.as_deref() == Some(v.id.as_str())),
            },
        )?;
        if let Some(thumb) = find(format!("thumbs/{}.webp", v.id)).filter(|t| glb::image_mime(t).is_some()) {
            write_atomic(&st.paths.version_thumb(&project.id, &created.id)?, &thumb)?;
            st.db.set_version_thumbnail(&created.id, true)?;
        }
        id_map.insert(v.id.clone(), created.id);
    }
    if id_map.is_empty() {
        st.db.delete_project(&project.id)?;
        return Err(AppError::new(ErrorCode::Validation, "That project file contains no models."));
    }
    let mut p = st.db.project(&project.id)?;
    if let Some(thumb) = data.project.thumbnail_version_id.and_then(|t| id_map.get(&t).cloned()) {
        p.thumbnail_version_id = Some(thumb);
        st.db.update_project(&p)?;
    }
    library::write_manifest(st, &project.id);
    library::emit(app, library::LibraryEvent::Project { project_id: project.id.clone() });
    Ok(project.id)
}

#[tauri::command]
pub async fn open_project_file<R: Runtime>(app: AppHandle<R>, token: Option<String>) -> AppResult<Option<String>> {
    let path = match token {
        Some(t) => app.state::<AppState>().take_grant(&t)?.path,
        None => {
            let dialog = app.dialog().file().set_title("Open a Shift3D project").add_filter("Shift3D project", &["shift3d"]);
            match blocking(move || dialog.blocking_pick_file().and_then(|p| p.into_path().ok())).await? {
                Some(p) => p,
                None => return Ok(None),
            }
        }
    };
    let app2 = app.clone();
    blocking(move || {
        let st = app2.state::<AppState>();
        let bytes = read_limited(&path, MAX_PROJECT_FILE_BYTES)?;
        import_project_archive(&app2, &st, &bytes)
    })
    .await?
    .map(Some)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub files: Vec<String>,
    pub bytes: u64,
}

fn write_project_archive(st: &AppState, project_id: &str, dest: &Path) -> AppResult<u64> {
    let project = st.db.project(project_id)?;
    let versions = st.db.versions(project_id)?;
    let tmp = dest.with_extension("shift3d.partial");
    {
        let file = std::fs::File::create(&tmp)?;
        let mut zip = zip::ZipWriter::new(file);
        let stored = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        let deflated = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let manifest = json!({ "format": "shift3d", "formatVersion": 1, "app": env!("CARGO_PKG_VERSION"), "exportedAt": now(), "project": project, "versions": versions });
        zip.start_file("project.json", deflated).map_err(|e| AppError::internal(e.to_string()))?;
        zip.write_all(&serde_json::to_vec_pretty(&manifest)?)?;
        for v in &versions {
            zip.start_file(format!("versions/{}.glb", v.id), stored).map_err(|e| AppError::internal(e.to_string()))?;
            zip.write_all(&library::version_bytes(st, &v.id)?)?;
            if v.has_thumbnail {
                if let Ok(t) = std::fs::read(st.paths.version_thumb(project_id, &v.id)?) {
                    zip.start_file(format!("thumbs/{}.webp", v.id), stored).map_err(|e| AppError::internal(e.to_string()))?;
                    zip.write_all(&t)?;
                }
            }
        }
        zip.finish().map_err(|e| AppError::internal(e.to_string()))?;
    }
    std::fs::rename(&tmp, dest).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })?;
    Ok(std::fs::metadata(dest)?.len())
}

#[tauri::command]
pub async fn save_project_file<R: Runtime>(app: AppHandle<R>, project_id: String) -> AppResult<Option<ExportResult>> {
    let st = app.state::<AppState>();
    let project = st.db.project(safe_id(&project_id)?)?;
    let dialog = app
        .dialog()
        .file()
        .set_title("Save project as")
        .add_filter("Shift3D project", &["shift3d"])
        .set_directory(st.settings.get().output_dir)
        .set_file_name(format!("{}.shift3d", safe_file_stem(&project.name)));
    let Some(dest) = blocking(move || dialog.blocking_save_file().and_then(|p| p.into_path().ok())).await? else { return Ok(None) };
    let app2 = app.clone();
    let dest2 = dest.clone();
    let bytes = blocking(move || write_project_archive(&app2.state::<AppState>(), &project_id, &dest2)).await??;
    Ok(Some(ExportResult { path: dest.to_string_lossy().into_owned(), files: vec![file_name(&dest)], bytes }))
}

/* --------------------------------- Exports --------------------------------- */

/// Unpacks `[u32 count]([u32 nameLen][name][u32 len][bytes])*` sent by the webview.
pub fn unpack_files(body: &[u8]) -> AppResult<Vec<(String, Vec<u8>)>> {
    let bad = || AppError::new(ErrorCode::Validation, "Malformed export data.");
    let mut o = 0usize;
    let u32_at = |o: &mut usize| -> AppResult<usize> {
        let b = body.get(*o..*o + 4).ok_or_else(bad)?;
        *o += 4;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize)
    };
    let count = u32_at(&mut o)?;
    if count == 0 || count > 64 {
        return Err(bad());
    }
    let mut files = Vec::with_capacity(count);
    for _ in 0..count {
        let n = u32_at(&mut o)?;
        let name = String::from_utf8(body.get(o..o + n).ok_or_else(bad)?.to_vec()).map_err(|_| bad())?;
        o += n;
        let len = u32_at(&mut o)?;
        let data = body.get(o..o + len).ok_or_else(bad)?.to_vec();
        o += len;
        // Sidecar names must be bare file names — never paths.
        if name.is_empty() || name.contains(['/', '\\', ':']) || name.starts_with('.') || name.len() > 120 {
            return Err(AppError::new(ErrorCode::Validation, "Invalid exported file name."));
        }
        files.push((name, data));
    }
    Ok(files)
}

fn format_filter(format: &str) -> (&'static str, &'static [&'static str]) {
    match format {
        "gltf" => ("glTF (separate files)", &["gltf"]),
        "obj" => ("Wavefront OBJ", &["obj"]),
        "stl" => ("STL (3D printing)", &["stl"]),
        "usdz" => ("USDZ (Apple AR)", &["usdz"]),
        "png" => ("PNG image", &["png"]),
        "mp4" => ("MP4 video", &["mp4"]),
        "gif" => ("Animated GIF", &["gif"]),
        _ => ("glTF Binary", &["glb"]),
    }
}

/// Writes the main file at `dest` and any sidecars next to it.
fn write_export(dest: &Path, files: &[(String, Vec<u8>)]) -> AppResult<ExportResult> {
    let dir = dest.parent().ok_or_else(|| AppError::new(ErrorCode::Validation, "Invalid destination."))?;
    let mut written = Vec::new();
    let mut total = 0u64;
    for (i, (name, data)) in files.iter().enumerate() {
        let path = if i == 0 { dest.to_path_buf() } else { dir.join(name) };
        write_atomic(&path, data)?;
        written.push(file_name(&path));
        total += data.len() as u64;
    }
    Ok(ExportResult { path: dest.to_string_lossy().into_owned(), files: written, bytes: total })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportMeta {
    suggested_name: String,
    format: String,
}

#[tauri::command]
pub async fn export_files<R: Runtime>(app: AppHandle<R>, request: Request<'_>) -> AppResult<Option<ExportResult>> {
    let (body, meta): (Vec<u8>, ExportMeta) = raw_request(&request)?;
    let files = unpack_files(&body)?;
    let (label, exts) = format_filter(&meta.format);
    let st = app.state::<AppState>();
    let dialog = app
        .dialog()
        .file()
        .set_title("Export model")
        .add_filter(label, exts)
        .set_directory(st.settings.get().output_dir)
        .set_file_name(format!("{}.{}", safe_file_stem(&meta.suggested_name), exts[0]));
    let Some(dest) = blocking(move || dialog.blocking_save_file().and_then(|p| p.into_path().ok())).await? else { return Ok(None) };
    let result = blocking(move || write_export(&dest, &files)).await??;
    Ok(Some(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MediaMeta {
    suggested_name: String,
    kind: String,
}

#[tauri::command]
pub async fn save_media<R: Runtime>(app: AppHandle<R>, request: Request<'_>) -> AppResult<Option<ExportResult>> {
    let (body, meta): (Vec<u8>, MediaMeta) = raw_request(&request)?;
    let valid = match meta.kind.as_str() {
        "png" => body.starts_with(&[0x89, b'P', b'N', b'G']),
        "gif" => body.starts_with(b"GIF8"),
        "mp4" => body.get(4..8) == Some(b"ftyp"),
        _ => false,
    };
    if !valid || body.len() > 512 * 1024 * 1024 {
        return Err(AppError::new(ErrorCode::Validation, "That media file is invalid."));
    }
    let (label, exts) = format_filter(&meta.kind);
    let st = app.state::<AppState>();
    let dialog = app
        .dialog()
        .file()
        .set_title("Save")
        .add_filter(label, exts)
        .set_directory(st.settings.get().output_dir)
        .set_file_name(format!("{}.{}", safe_file_stem(&meta.suggested_name), exts[0]));
    let Some(dest) = blocking(move || dialog.blocking_save_file().and_then(|p| p.into_path().ok())).await? else { return Ok(None) };
    let result = blocking(move || write_export(&dest, &[("media".into(), body)])).await??;
    Ok(Some(result))
}

/* ------------------------------ Integrations ------------------------------ */

fn godot_project(st: &AppState) -> AppResult<PathBuf> {
    let path = st.settings.get().godot_project_path.map(PathBuf::from).ok_or_else(|| {
        AppError::new(ErrorCode::Validation, "No Godot project is linked yet.").with_hint("Choose your project folder in Export → Send to Godot (or in Settings).")
    })?;
    if !path.join("project.godot").is_file() {
        return Err(AppError::new(ErrorCode::NotFound, "The linked Godot project can't be found.").with_hint("Choose the project folder again (it must contain project.godot)."));
    }
    Ok(path)
}

#[tauri::command]
pub async fn pick_godot_project<R: Runtime>(app: AppHandle<R>) -> AppResult<Option<String>> {
    let dialog = app.dialog().file().set_title("Choose your Godot project folder");
    let Some(dir) = blocking(move || dialog.blocking_pick_folder().and_then(|p| p.into_path().ok())).await? else { return Ok(None) };
    if !dir.join("project.godot").is_file() {
        return Err(AppError::new(ErrorCode::Validation, "That folder isn't a Godot project.").with_hint("Pick the folder that contains project.godot."));
    }
    let path = dir.to_string_lossy().into_owned();
    app.state::<AppState>().settings.update(|s| s.godot_project_path = Some(path.clone()))?;
    Ok(Some(path))
}

#[derive(Deserialize)]
struct GodotMeta {
    name: String,
}

#[tauri::command]
pub async fn send_to_godot<R: Runtime>(app: AppHandle<R>, request: Request<'_>) -> AppResult<ExportResult> {
    let (body, meta): (Vec<u8>, GodotMeta) = raw_request(&request)?;
    let files = unpack_files(&body)?;
    let st = app.state::<AppState>();
    let root = godot_project(&st)?;
    let models = root.join("models");
    std::fs::create_dir_all(&models)?;
    let stem = safe_file_stem(&meta.name);
    let main_ext = Path::new(&files[0].0).extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_else(|| "glb".into());
    let dest = models.join(format!("{stem}.{main_ext}"));
    let mut result = blocking(move || write_export(&dest, &files)).await??;
    result.path = format!("res://models/{stem}.{main_ext}");
    Ok(result)
}

const BLENDER_IMPORT: &str = "import bpy, os\n\
for o in list(bpy.data.objects):\n    if o.name == 'Cube': bpy.data.objects.remove(o, do_unlink=True)\n\
bpy.ops.import_scene.gltf(filepath=os.environ['SHIFT3D_IMPORT'])\n";

pub fn find_blender() -> Option<PathBuf> {
    let roots = [std::env::var_os("ProgramFiles"), std::env::var_os("ProgramW6432"), std::env::var_os("LOCALAPPDATA").map(|l| PathBuf::from(l).join("Programs").into_os_string())];
    let mut found: Vec<PathBuf> = Vec::new();
    for root in roots.into_iter().flatten() {
        let base = PathBuf::from(root).join("Blender Foundation");
        if let Ok(entries) = std::fs::read_dir(&base) {
            for e in entries.flatten() {
                let exe = e.path().join("blender.exe");
                if exe.is_file() {
                    found.push(exe);
                }
            }
        }
    }
    // "Blender 4.2" < "Blender 4.10" — compare numerically by version.
    found.sort_by_key(|p| {
        let name = p.parent().and_then(|d| d.file_name()).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        name.split(|c: char| !c.is_ascii_digit()).filter_map(|n| n.parse::<u32>().ok()).collect::<Vec<_>>()
    });
    found.pop()
}

#[tauri::command]
pub fn detect_blender(st: State<'_, AppState>) -> AppResult<Option<String>> {
    if let Some(p) = st.settings.get().blender_path.filter(|p| Path::new(p).is_file()) {
        return Ok(Some(p));
    }
    let found = find_blender().map(|p| p.to_string_lossy().into_owned());
    if let Some(p) = &found {
        st.settings.update(|s| s.blender_path = Some(p.clone()))?;
    }
    Ok(found)
}

#[tauri::command]
pub async fn pick_blender_path<R: Runtime>(app: AppHandle<R>) -> AppResult<Option<String>> {
    let dialog = app.dialog().file().set_title("Locate blender.exe").add_filter("Blender", &["exe"]);
    let Some(path) = blocking(move || dialog.blocking_pick_file().and_then(|p| p.into_path().ok())).await? else { return Ok(None) };
    if !file_name(&path).eq_ignore_ascii_case("blender.exe") {
        return Err(AppError::new(ErrorCode::Validation, "That isn't blender.exe.").with_hint("It's usually in C:\\Program Files\\Blender Foundation\\Blender x.y."));
    }
    let p = path.to_string_lossy().into_owned();
    app.state::<AppState>().settings.update(|s| s.blender_path = Some(p.clone()))?;
    Ok(Some(p))
}

#[tauri::command]
pub fn open_in_blender(st: State<'_, AppState>, version_id: String) -> AppResult<()> {
    let v = st.db.version(safe_id(&version_id)?)?;
    let model = st.paths.version_model(&v.project_id, &v.id)?;
    let blender = st
        .settings
        .get()
        .blender_path
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .or_else(find_blender)
        .ok_or_else(|| AppError::new(ErrorCode::NotFound, "Blender isn't installed (or Shift3D can't find it).").with_hint("Install it from blender.org, or locate blender.exe in Settings → Integrations."))?;
    // The model path travels in an environment variable, never inside the Python source.
    std::process::Command::new(&blender)
        .arg("--python-expr")
        .arg(BLENDER_IMPORT)
        .env("SHIFT3D_IMPORT", &model)
        .spawn()
        .map_err(|e| AppError::new(ErrorCode::Io, format!("Couldn't start Blender: {e}")))?;
    Ok(())
}

#[tauri::command]
pub async fn pick_output_dir<R: Runtime>(app: AppHandle<R>) -> AppResult<Option<String>> {
    let dialog = app.dialog().file().set_title("Choose the default export folder");
    let Some(dir) = blocking(move || dialog.blocking_pick_folder().and_then(|p| p.into_path().ok())).await? else { return Ok(None) };
    let p = dir.to_string_lossy().into_owned();
    app.state::<AppState>().settings.update(|s| s.output_dir = p.clone())?;
    Ok(Some(p))
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RevealTarget {
    Project { id: String },
    Version { id: String },
    Path { path: String },
}

#[tauri::command]
pub fn reveal<R: Runtime>(app: AppHandle<R>, st: State<'_, AppState>, target: RevealTarget) -> AppResult<()> {
    let path = match target {
        RevealTarget::Project { id } => st.paths.project_dir(safe_id(&id)?)?.join("project.json"),
        RevealTarget::Version { id } => {
            let v = st.db.version(safe_id(&id)?)?;
            st.paths.version_model(&v.project_id, &v.id)?
        }
        RevealTarget::Path { path } => {
            // Only places Shift3D itself writes to (library, export folder, linked Godot project).
            let p = PathBuf::from(&path);
            let settings = st.settings.get();
            let mut roots = vec![st.paths.library_dir.clone(), PathBuf::from(&settings.output_dir)];
            if let Some(g) = settings.godot_project_path {
                roots.push(PathBuf::from(g));
            }
            if !p.exists() || !roots.iter().any(|r| is_within(r, &p)) {
                return Err(AppError::new(ErrorCode::Validation, "Shift3D can only show files it created.").with_hint("Open the folder from File Explorer instead."));
            }
            p
        }
    };
    app.opener().reveal_item_in_dir(&path).map_err(|e| AppError::new(ErrorCode::Io, format!("Couldn't open File Explorer: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pack(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out = (files.len() as u32).to_le_bytes().to_vec();
        for (n, d) in files {
            out.extend_from_slice(&(n.len() as u32).to_le_bytes());
            out.extend_from_slice(n.as_bytes());
            out.extend_from_slice(&(d.len() as u32).to_le_bytes());
            out.extend_from_slice(d);
        }
        out
    }

    #[test]
    fn unpack_rejects_paths() {
        assert_eq!(unpack_files(&pack(&[("a.gltf", b"{}"), ("a.bin", b"x")])).unwrap().len(), 2);
        assert!(unpack_files(&pack(&[("../evil.dll", b"x")])).is_err());
        assert!(unpack_files(&pack(&[("C:\\x.exe", b"x")])).is_err());
        assert!(unpack_files(&[1, 0, 0, 0, 255]).is_err());
    }

    fn zip_with(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            for (name, data) in entries {
                z.start_file(*name, opts).unwrap();
                z.write_all(data).unwrap();
            }
            z.finish().unwrap();
        }
        buf.into_inner()
    }

    #[test]
    fn archive_ignores_unknown_and_traversal_entries() {
        let glb = crate::glb::tests::triangle_glb();
        let bytes = zip_with(&[("project.json", br#"{"a":1}"#), ("versions/v_1.glb", &glb), ("../../evil.exe", b"MZ"), ("versions/../x.glb", b"x")]);
        let (manifest, files) = read_project_archive(&bytes).unwrap();
        assert_eq!(manifest["a"], 1);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].0, "versions/v_1.glb");
    }

    #[test]
    fn archive_rejects_zip_bombs() {
        // 20 MB of zeros compresses ~1000:1 — the ratio guard must refuse it.
        let zeros = vec![0u8; 20 * 1024 * 1024];
        let bytes = zip_with(&[("project.json", b"{}"), ("versions/v_1.glb", &zeros)]);
        assert!(read_project_archive(&bytes).is_err());
    }

    #[test]
    fn gltf_with_sidecar_packs_to_glb() {
        let dir = std::env::temp_dir().join(format!("s3d-gltf-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut bin = Vec::new();
        for f in [0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0] {
            bin.extend_from_slice(&f.to_le_bytes());
        }
        std::fs::write(dir.join("tri.bin"), &bin).unwrap();
        let gltf = json!({
            "asset": { "version": "2.0" },
            "buffers": [{ "uri": "tri.bin", "byteLength": 36 }],
            "bufferViews": [{ "buffer": 0, "byteLength": 36 }],
            "accessors": [{ "bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3" }],
            "meshes": [{ "primitives": [{ "attributes": { "POSITION": 0 } }] }]
        });
        std::fs::write(dir.join("tri.gltf"), serde_json::to_vec(&gltf).unwrap()).unwrap();
        let out = gltf_to_glb(&dir.join("tri.gltf")).unwrap();
        assert_eq!(glb::stats(&out).unwrap().triangles, 1);
        // Traversal outside the folder is refused.
        let evil = json!({ "asset": { "version": "2.0" }, "buffers": [{ "uri": "../secret.bin", "byteLength": 1 }] });
        std::fs::write(dir.join("evil.gltf"), serde_json::to_vec(&evil).unwrap()).unwrap();
        assert!(gltf_to_glb(&dir.join("evil.gltf")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
