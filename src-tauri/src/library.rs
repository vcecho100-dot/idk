//! Library commands: projects, versions, thumbnails. Model files live on disk under
//! Documents/Shift3D/Projects/<project-id>/; the database is the index.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::db::{now, Project, Version};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::glb;
use crate::paths::safe_id;
use crate::settings::write_atomic;
use crate::state::{new_id, AppState};

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LibraryEvent {
    Project {
        #[serde(rename = "projectId")]
        project_id: String,
    },
    Deleted {
        #[serde(rename = "projectId")]
        project_id: String,
    },
    Reset,
}

pub fn emit<R: Runtime>(app: &AppHandle<R>, e: LibraryEvent) {
    let _ = app.emit("library://changed", e);
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDetail {
    pub project: Project,
    pub versions: Vec<Version>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewVersionMeta {
    pub project_id: String,
    pub parent_id: Option<String>,
    pub kind: String,
    pub label: String,
    /// Stats sent by the UI are ignored: the engine always recomputes them from the file.
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Default)]
pub struct VersionExtra {
    pub provider: Option<String>,
    pub variant_group: Option<String>,
    pub variant_index: Option<i64>,
    /// `None` = make current; `Some(false)` = keep the current pointer (variants).
    pub make_current: Option<bool>,
}

const VERSION_KINDS: &[&str] = &["generate", "refine", "retexture", "stylize", "optimize", "transform", "material", "rig", "import"];

/* ------------------------------- Internals -------------------------------- */

pub fn create_project(st: &AppState, name: &str, prompt: &str, style: Option<String>, provider: Option<String>) -> AppResult<Project> {
    let t = now();
    let p = Project {
        id: new_id("p_"),
        name: clean_name(name)?,
        created_at: t.clone(),
        updated_at: t,
        favorite: false,
        tags: vec![],
        prompt: prompt.chars().take(2000).collect(),
        style,
        provider,
        current_version_id: None,
        thumbnail_version_id: None,
        version_count: 0,
        size_bytes: 0,
    };
    std::fs::create_dir_all(st.paths.project_dir(&p.id)?.join("versions"))?;
    st.db.insert_project(&p)?;
    Ok(p)
}

fn clean_name(name: &str) -> AppResult<String> {
    let n: String = name.trim().chars().filter(|c| !c.is_control()).take(120).collect();
    if n.is_empty() {
        Err(AppError::new(ErrorCode::Validation, "Project names can't be empty."))
    } else {
        Ok(n)
    }
}

/// Validates and stores a model as a new version. Used by tools, jobs and imports.
pub fn add_version<R: Runtime>(app: &AppHandle<R>, st: &AppState, meta: NewVersionMeta, bytes: &[u8], extra: VersionExtra) -> AppResult<Version> {
    safe_id(&meta.project_id)?;
    if !VERSION_KINDS.contains(&meta.kind.as_str()) {
        return Err(AppError::new(ErrorCode::Validation, "Unknown version type."));
    }
    let parsed = glb::parse(bytes)?;
    let stats = glb::stats_of(&parsed, bytes.len() as u64);
    let mut project = st.db.project(&meta.project_id)?;
    if let Some(parent) = &meta.parent_id {
        let pv = st.db.version(parent)?;
        if pv.project_id != project.id {
            return Err(AppError::new(ErrorCode::Validation, "That version belongs to another project."));
        }
    }
    let v = Version {
        id: new_id("v_"),
        project_id: project.id.clone(),
        parent_id: meta.parent_id,
        kind: meta.kind,
        label: meta.label.chars().take(80).collect(),
        created_at: now(),
        provider: extra.provider,
        params: if meta.params.is_object() { meta.params } else { Value::Object(Default::default()) },
        stats: Some(stats),
        file_size: bytes.len() as u64,
        has_thumbnail: false,
        variant_group: extra.variant_group,
        variant_index: extra.variant_index,
    };
    write_atomic(&st.paths.version_model(&project.id, &v.id)?, bytes)?;
    st.db.insert_version(&v)?;
    project.updated_at = v.created_at.clone();
    if extra.make_current.unwrap_or(true) || project.current_version_id.is_none() {
        project.current_version_id = Some(v.id.clone());
    }
    st.db.update_project(&project)?;
    write_manifest(st, &project.id);
    emit(app, LibraryEvent::Project { project_id: project.id.clone() });
    Ok(v)
}

/// Keeps a human-readable project.json next to the models, so the folder is self-describing.
pub fn write_manifest(st: &AppState, project_id: &str) {
    let Ok(project) = st.db.project(project_id) else { return };
    let Ok(versions) = st.db.versions(project_id) else { return };
    let Ok(dir) = st.paths.project_dir(project_id) else { return };
    let manifest = serde_json::json!({
        "format": "shift3d-project",
        "formatVersion": 1,
        "project": project,
        "versions": versions,
    });
    if let Ok(bytes) = serde_json::to_vec_pretty(&manifest) {
        let _ = write_atomic(&dir.join("project.json"), &bytes);
    }
}

pub fn version_bytes(st: &AppState, version_id: &str) -> AppResult<Vec<u8>> {
    let v = st.db.version(version_id)?;
    std::fs::read(st.paths.version_model(&v.project_id, &v.id)?).map_err(|_| {
        AppError::new(ErrorCode::NotFound, "This version's model file is missing.")
            .with_hint("It may have been deleted outside Shift3D. Pick another version.")
    })
}

/// Reads the raw IPC body and the percent-encoded JSON metadata header.
pub fn raw_request<T: serde::de::DeserializeOwned>(request: &Request<'_>) -> AppResult<(Vec<u8>, T)> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::new(ErrorCode::Validation, "Expected binary data."));
    };
    let header = request
        .headers()
        .get("x-s3d-meta")
        .and_then(|h| h.to_str().ok())
        .ok_or_else(|| AppError::new(ErrorCode::Validation, "Missing request metadata."))?;
    let decoded = percent_encoding::percent_decode_str(header).decode_utf8_lossy();
    let meta = serde_json::from_str(&decoded)?;
    Ok((bytes.clone(), meta))
}

/* -------------------------------- Commands -------------------------------- */

#[tauri::command]
pub fn list_projects(st: State<'_, AppState>) -> AppResult<Vec<Project>> {
    st.db.projects()
}

#[tauri::command]
pub fn get_project(st: State<'_, AppState>, id: String) -> AppResult<ProjectDetail> {
    Ok(ProjectDetail { project: st.db.project(safe_id(&id)?)?, versions: st.db.versions(&id)? })
}

#[tauri::command]
pub fn rename_project<R: Runtime>(app: AppHandle<R>, st: State<'_, AppState>, id: String, name: String) -> AppResult<Project> {
    let mut p = st.db.project(safe_id(&id)?)?;
    p.name = clean_name(&name)?;
    p.updated_at = now();
    st.db.update_project(&p)?;
    write_manifest(&st, &id);
    emit(&app, LibraryEvent::Project { project_id: id.clone() });
    st.db.project(&id)
}

#[tauri::command]
pub fn set_favorite<R: Runtime>(app: AppHandle<R>, st: State<'_, AppState>, id: String, favorite: bool) -> AppResult<Project> {
    let mut p = st.db.project(safe_id(&id)?)?;
    p.favorite = favorite;
    st.db.update_project(&p)?;
    emit(&app, LibraryEvent::Project { project_id: id.clone() });
    st.db.project(&id)
}

#[tauri::command]
pub fn set_tags<R: Runtime>(app: AppHandle<R>, st: State<'_, AppState>, id: String, tags: Vec<String>) -> AppResult<Project> {
    let mut p = st.db.project(safe_id(&id)?)?;
    let mut clean: Vec<String> = tags
        .iter()
        .map(|t| t.trim().to_lowercase().chars().filter(|c| !c.is_control()).take(32).collect::<String>())
        .filter(|t| !t.is_empty())
        .collect();
    clean.dedup();
    clean.truncate(20);
    p.tags = clean;
    st.db.update_project(&p)?;
    write_manifest(&st, &id);
    emit(&app, LibraryEvent::Project { project_id: id.clone() });
    st.db.project(&id)
}

#[tauri::command]
pub fn set_current_version<R: Runtime>(app: AppHandle<R>, st: State<'_, AppState>, project_id: String, version_id: String) -> AppResult<()> {
    let v = st.db.version(safe_id(&version_id)?)?;
    let mut p = st.db.project(safe_id(&project_id)?)?;
    if v.project_id != p.id {
        return Err(AppError::new(ErrorCode::Validation, "That version belongs to another project."));
    }
    p.current_version_id = Some(v.id.clone());
    if v.has_thumbnail {
        p.thumbnail_version_id = Some(v.id.clone());
    }
    st.db.update_project(&p)?;
    write_manifest(&st, &project_id);
    emit(&app, LibraryEvent::Project { project_id });
    Ok(())
}

#[tauri::command]
pub async fn create_version<R: Runtime>(app: AppHandle<R>, request: Request<'_>) -> AppResult<Version> {
    let (bytes, meta): (Vec<u8>, NewVersionMeta) = raw_request(&request)?;
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let st = app2.state::<AppState>();
        add_version(&app2, &st, meta, &bytes, VersionExtra::default())
    })
    .await
    .map_err(|e| AppError::internal(e.to_string()))?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThumbMeta {
    version_id: String,
}

#[tauri::command]
pub async fn save_thumbnail<R: Runtime>(app: AppHandle<R>, request: Request<'_>) -> AppResult<()> {
    let (bytes, meta): (Vec<u8>, ThumbMeta) = raw_request(&request)?;
    if bytes.len() > 4 * 1024 * 1024 || glb::image_mime(&bytes).is_none() {
        return Err(AppError::new(ErrorCode::Validation, "Thumbnails must be a PNG, JPEG or WebP under 4 MB."));
    }
    let st = app.state::<AppState>();
    let v = st.db.version(safe_id(&meta.version_id)?)?;
    write_atomic(&st.paths.version_thumb(&v.project_id, &v.id)?, &bytes)?;
    st.db.set_version_thumbnail(&v.id, true)?;
    let mut p = st.db.project(&v.project_id)?;
    if p.current_version_id.as_deref() == Some(v.id.as_str()) || p.thumbnail_version_id.is_none() {
        p.thumbnail_version_id = Some(v.id.clone());
        st.db.update_project(&p)?;
    }
    emit(&app, LibraryEvent::Project { project_id: v.project_id });
    Ok(())
}

#[tauri::command]
pub async fn duplicate_project<R: Runtime>(app: AppHandle<R>, id: String) -> AppResult<Project> {
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let st = app2.state::<AppState>();
        let src = st.db.project(safe_id(&id)?)?;
        let mut copy = create_project(&st, &format!("{} copy", src.name), &src.prompt, src.style.clone(), src.provider.clone())?;
        copy.tags = src.tags.clone();
        st.db.update_project(&copy)?;
        let mut id_map = std::collections::HashMap::new();
        for v in st.db.versions(&src.id)? {
            let bytes = version_bytes(&st, &v.id)?;
            let created = add_version(
                &app2,
                &st,
                NewVersionMeta {
                    project_id: copy.id.clone(),
                    parent_id: v.parent_id.as_ref().and_then(|p| id_map.get(p).cloned()),
                    kind: v.kind.clone(),
                    label: v.label.clone(),
                    params: v.params.clone(),
                },
                &bytes,
                VersionExtra {
                    provider: v.provider.clone(),
                    variant_group: v.variant_group.clone(),
                    variant_index: v.variant_index,
                    make_current: Some(src.current_version_id.as_deref() == Some(v.id.as_str())),
                },
            )?;
            if v.has_thumbnail {
                if let Ok(thumb) = std::fs::read(st.paths.version_thumb(&src.id, &v.id)?) {
                    write_atomic(&st.paths.version_thumb(&copy.id, &created.id)?, &thumb)?;
                    st.db.set_version_thumbnail(&created.id, true)?;
                    if src.thumbnail_version_id.as_deref() == Some(v.id.as_str()) {
                        let mut p = st.db.project(&copy.id)?;
                        p.thumbnail_version_id = Some(created.id.clone());
                        st.db.update_project(&p)?;
                    }
                }
            }
            id_map.insert(v.id.clone(), created.id);
        }
        write_manifest(&st, &copy.id);
        emit(&app2, LibraryEvent::Project { project_id: copy.id.clone() });
        st.db.project(&copy.id)
    })
    .await
    .map_err(|e| AppError::internal(e.to_string()))?
}

/// Moves the project folder to the Recycle Bin — never a permanent delete.
#[tauri::command]
pub async fn delete_project<R: Runtime>(app: AppHandle<R>, id: String) -> AppResult<()> {
    let st = app.state::<AppState>();
    safe_id(&id)?;
    st.db.project(&id)?;
    st.jobs.cancel_project(&id);
    let dir = st.paths.project_dir(&id)?;
    if dir.exists() {
        trash::delete(&dir).map_err(|e| {
            AppError::new(ErrorCode::Io, format!("Couldn't move the project to the Recycle Bin: {e}"))
                .with_hint("Close any app that has its files open, then try again.")
        })?;
    }
    st.db.delete_project(&id)?;
    emit(&app, LibraryEvent::Deleted { project_id: id });
    Ok(())
}

#[tauri::command]
pub async fn delete_version<R: Runtime>(app: AppHandle<R>, id: String) -> AppResult<()> {
    let st = app.state::<AppState>();
    let v = st.db.version(safe_id(&id)?)?;
    let mut p = st.db.project(&v.project_id)?;
    let others: Vec<Version> = st.db.versions(&p.id)?.into_iter().filter(|x| x.id != v.id).collect();
    if others.is_empty() {
        return Err(AppError::new(ErrorCode::Validation, "A project needs at least one version.")
            .with_hint("Delete the whole project from the Library instead."));
    }
    for path in [st.paths.version_model(&p.id, &v.id)?, st.paths.version_thumb(&p.id, &v.id)?] {
        if path.exists() {
            trash::delete(&path).map_err(|e| AppError::new(ErrorCode::Io, format!("Couldn't move the file to the Recycle Bin: {e}")))?;
        }
    }
    st.db.reparent_children(&v.id, v.parent_id.as_deref())?;
    st.db.delete_version(&v.id)?;
    let latest = others.iter().max_by(|a, b| a.created_at.cmp(&b.created_at)).expect("non-empty");
    if p.current_version_id.as_deref() == Some(v.id.as_str()) {
        p.current_version_id = Some(latest.id.clone());
    }
    if p.thumbnail_version_id.as_deref() == Some(v.id.as_str()) {
        p.thumbnail_version_id = others.iter().rev().find(|x| x.has_thumbnail).map(|x| x.id.clone());
    }
    p.updated_at = now();
    st.db.update_project(&p)?;
    write_manifest(&st, &p.id);
    emit(&app, LibraryEvent::Project { project_id: p.id });
    Ok(())
}
