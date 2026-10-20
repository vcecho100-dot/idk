//! Where Shift3D keeps things.
//!
//! - User-facing files live in `Documents/Shift3D/` so people can always find them:
//!   `Projects/<project-id>/versions/*.glb`, `thumbs/*.webp`, `project.json`, and `Exports/`.
//! - The SQLite library index, settings and transient staging live in the app data dir
//!   (Documents is often OneDrive-synced, which is hostile to SQLite's WAL files).

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};

use crate::error::{AppError, AppResult, ErrorCode};

#[derive(Debug, Clone)]
pub struct AppPaths {
    pub data_dir: PathBuf,
    pub db_path: PathBuf,
    pub settings_path: PathBuf,
    pub staging_dir: PathBuf,
    pub library_dir: PathBuf,
    pub projects_dir: PathBuf,
    pub exports_dir: PathBuf,
}

impl AppPaths {
    pub fn resolve<R: Runtime>(app: &AppHandle<R>) -> AppResult<Self> {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| AppError::internal(format!("No app data folder: {e}")))?;
        let documents = app
            .path()
            .document_dir()
            .or_else(|_| app.path().home_dir().map(|h| h.join("Documents")))
            .map_err(|e| AppError::internal(format!("No Documents folder: {e}")))?;
        Ok(Self::from_roots(data_dir, documents.join("Shift3D")))
    }

    pub fn from_roots(data_dir: PathBuf, library_dir: PathBuf) -> Self {
        Self {
            db_path: data_dir.join("library.db"),
            settings_path: data_dir.join("settings.json"),
            staging_dir: data_dir.join("staging"),
            projects_dir: library_dir.join("Projects"),
            exports_dir: library_dir.join("Exports"),
            data_dir,
            library_dir,
        }
    }

    pub fn ensure(&self) -> AppResult<()> {
        for dir in [&self.data_dir, &self.staging_dir, &self.library_dir, &self.projects_dir, &self.exports_dir] {
            std::fs::create_dir_all(dir)?;
        }
        Ok(())
    }

    pub fn project_dir(&self, project_id: &str) -> AppResult<PathBuf> {
        Ok(self.projects_dir.join(safe_id(project_id)?))
    }

    pub fn version_model(&self, project_id: &str, version_id: &str) -> AppResult<PathBuf> {
        Ok(self.project_dir(project_id)?.join("versions").join(format!("{}.glb", safe_id(version_id)?)))
    }

    pub fn version_thumb(&self, project_id: &str, version_id: &str) -> AppResult<PathBuf> {
        Ok(self.project_dir(project_id)?.join("thumbs").join(format!("{}.webp", safe_id(version_id)?)))
    }

    pub fn staged_image(&self, id: &str) -> AppResult<PathBuf> {
        Ok(self.staging_dir.join(safe_id(id)?))
    }
}

/// IDs become path segments, so only `[A-Za-z0-9_-]` is ever allowed — no traversal possible.
pub fn safe_id(id: &str) -> AppResult<&str> {
    if !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        Ok(id)
    } else {
        Err(AppError::new(ErrorCode::Validation, "Invalid identifier."))
    }
}

/// Turns user text into a safe Windows file name stem (no reserved names, no separators).
pub fn safe_file_stem(name: &str) -> String {
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1",
        "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() || r#"<>:"/\|?*"#.contains(c) { '_' } else { c })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .chars()
        .take(80)
        .collect();
    let stem = if cleaned.is_empty() { "model".to_string() } else { cleaned };
    if RESERVED.iter().any(|r| r.eq_ignore_ascii_case(&stem)) {
        format!("{stem}_")
    } else {
        stem
    }
}

/// True if `child` is inside `parent` after canonicalization (both must exist).
pub fn is_within(parent: &Path, child: &Path) -> bool {
    match (dunce_canonical(parent), dunce_canonical(child)) {
        (Some(p), Some(c)) => c.starts_with(p),
        _ => false,
    }
}

fn dunce_canonical(p: &Path) -> Option<PathBuf> {
    let c = std::fs::canonicalize(p).ok()?;
    // Strip the `\\?\` verbatim prefix Windows adds so comparisons are stable.
    let s = c.to_string_lossy();
    Some(PathBuf::from(s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_reject_traversal() {
        assert!(safe_id("v_abc123").is_ok());
        assert!(safe_id("../etc").is_err());
        assert!(safe_id("a/b").is_err());
        assert!(safe_id("a\\b").is_err());
        assert!(safe_id("").is_err());
        assert!(safe_id("C:").is_err());
    }

    #[test]
    fn file_stems_are_windows_safe() {
        assert_eq!(safe_file_stem("My Robot: v2?"), "My Robot_ v2_");
        assert_eq!(safe_file_stem("..\\..\\evil"), "_.._evil");
        assert_eq!(safe_file_stem("CON"), "CON_");
        assert_eq!(safe_file_stem("   "), "model");
        assert_eq!(safe_file_stem("a.b."), "a.b");
    }

    #[test]
    fn within_detects_escape() {
        let tmp = std::env::temp_dir().join(format!("s3d-within-{}", std::process::id()));
        let inner = tmp.join("inner");
        std::fs::create_dir_all(&inner).unwrap();
        assert!(is_within(&tmp, &inner));
        assert!(!is_within(&inner, &tmp));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
