//! A single error type for every command. It serializes to a friendly,
//! actionable shape (`code`, `message`, `hint`) that the UI renders directly.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    Offline,
    Network,
    Timeout,
    Auth,
    RateLimited,
    Credits,
    Provider,
    Validation,
    NotFound,
    Io,
    Cancelled,
    Unsupported,
    #[serde(other)]
    Internal,
}

#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{message}")]
pub struct AppError {
    pub code: ErrorCode,
    /// What happened, in plain words.
    pub message: String,
    /// What the user can do next.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), hint: None }
    }

    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
            .with_hint("Try again. If it keeps happening, restart Shift3D.")
    }
}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        use std::io::ErrorKind;
        match err.kind() {
            ErrorKind::NotFound => AppError::new(ErrorCode::NotFound, "The file or folder could not be found.")
                .with_hint("It may have been moved or deleted. Pick it again."),
            ErrorKind::PermissionDenied => AppError::new(ErrorCode::Io, "Windows denied access to that location.")
                .with_hint("Choose a folder you can write to, or close apps that might be using the file."),
            ErrorKind::StorageFull => AppError::new(ErrorCode::Io, "The disk is full.")
                .with_hint("Free up some space, then try again."),
            _ => AppError::new(ErrorCode::Io, format!("A file operation failed: {err}")),
        }
    }
}

impl From<tauri::Error> for AppError {
    fn from(err: tauri::Error) -> Self {
        AppError::internal(err.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(err: serde_json::Error) -> Self {
        AppError::new(ErrorCode::Validation, format!("Unexpected data format: {err}"))
    }
}
