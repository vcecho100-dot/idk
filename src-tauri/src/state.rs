//! Shared engine state, managed by Tauri.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;

use crate::db::Db;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::jobs::JobQueue;
use crate::net::Net;
use crate::paths::AppPaths;
use crate::settings::SettingsStore;

/// An image the user picked, dropped or pasted, copied into the staging folder.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedImage {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub width: u32,
    pub height: u32,
    pub url: String,
}

/// What a grant token refers to: a file the user explicitly chose (drop, file association, dialog).
#[derive(Debug, Clone)]
pub struct Grant {
    pub path: PathBuf,
}

pub struct AppState {
    pub paths: AppPaths,
    pub db: Db,
    pub settings: SettingsStore,
    pub net: Net,
    pub jobs: JobQueue,
    grants: Mutex<HashMap<String, Grant>>,
    staged: Mutex<HashMap<String, StagedImage>>,
}

pub fn new_id(prefix: &str) -> String {
    format!("{prefix}{}", uuid::Uuid::new_v4().simple())
}

impl AppState {
    pub fn new(paths: AppPaths, db: Db, settings: SettingsStore, net: Net, jobs: JobQueue) -> Self {
        Self { paths, db, settings, net, jobs, grants: Mutex::new(HashMap::new()), staged: Mutex::new(HashMap::new()) }
    }

    /// Records a user-granted file and returns an opaque token the webview can refer to.
    pub fn grant(&self, path: PathBuf) -> String {
        let token = new_id("g_");
        self.grants.lock().expect("grants lock").insert(token.clone(), Grant { path });
        token
    }

    /// Consumes a grant token (single use).
    pub fn take_grant(&self, token: &str) -> AppResult<Grant> {
        self.grants.lock().expect("grants lock").remove(token).ok_or_else(|| {
            AppError::new(ErrorCode::NotFound, "That file is no longer available.").with_hint("Drop or open it again.")
        })
    }

    pub fn add_staged(&self, img: StagedImage) {
        self.staged.lock().expect("staged lock").insert(img.id.clone(), img);
    }

    pub fn staged(&self, id: &str) -> AppResult<StagedImage> {
        self.staged.lock().expect("staged lock").get(id).cloned().ok_or_else(|| {
            AppError::new(ErrorCode::NotFound, "That image is no longer available.").with_hint("Add it again.")
        })
    }
}
