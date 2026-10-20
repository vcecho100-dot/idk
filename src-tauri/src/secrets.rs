//! API keys live only in Windows Credential Manager (via `keyring`).
//! They are never written to disk by Shift3D, never logged, and never sent to the webview.

use crate::error::{AppError, AppResult, ErrorCode};

const SERVICE: &str = "Shift3D";

pub const KEYED_PROVIDERS: &[&str] = &["tripo", "meshy", "fal", "hfspace"];

fn entry(provider: &str) -> AppResult<keyring::Entry> {
    if !KEYED_PROVIDERS.contains(&provider) {
        return Err(AppError::new(ErrorCode::Validation, "That provider doesn't use an API key."));
    }
    keyring::Entry::new(SERVICE, &format!("{provider}-api-key"))
        .map_err(|e| AppError::internal(format!("Credential Manager is unavailable: {e}")))
}

pub fn get(provider: &str) -> AppResult<Option<String>> {
    match entry(provider)?.get_password() {
        Ok(k) if !k.is_empty() => Ok(Some(k)),
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::internal(format!("Couldn't read the key from Credential Manager: {e}"))),
    }
}

pub fn has(provider: &str) -> bool {
    matches!(get(provider), Ok(Some(_)))
}

pub fn set(provider: &str, key: &str) -> AppResult<()> {
    let key = key.trim();
    validate_shape(provider, key)?;
    entry(provider)?
        .set_password(key)
        .map_err(|e| AppError::internal(format!("Couldn't save the key to Credential Manager: {e}")))
}

pub fn clear(provider: &str) -> AppResult<()> {
    match entry(provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::internal(format!("Couldn't remove the key: {e}"))),
    }
}

pub fn clear_all() {
    for p in KEYED_PROVIDERS {
        let _ = clear(p);
    }
}

/// Catches obvious paste mistakes before anything is stored.
fn validate_shape(provider: &str, key: &str) -> AppResult<()> {
    let bad = |hint: &str| Err(AppError::new(ErrorCode::Validation, "That doesn't look like a valid API key.").with_hint(hint.to_string()));
    if key.len() < 8 || key.len() > 512 || key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return bad("Copy the whole key from the provider's dashboard, without spaces.");
    }
    match provider {
        "tripo" if !key.starts_with("tsk_") => bad("Tripo keys start with “tsk_”."),
        "meshy" if !key.starts_with("msy_") => bad("Meshy keys start with “msy_”."),
        "hfspace" if !key.starts_with("hf_") => bad("Hugging Face tokens start with “hf_”."),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shape_validation() {
        assert!(validate_shape("tripo", "tsk_abcdefgh1234").is_ok());
        assert!(validate_shape("tripo", "sk-abcdefgh1234").is_err());
        assert!(validate_shape("meshy", "msy_abcdefgh1234").is_ok());
        assert!(validate_shape("fal", "1234abcd-ef:5678").is_ok());
        assert!(validate_shape("fal", "has space here").is_err());
        assert!(validate_shape("hfspace", "hf_abcdefghijk").is_ok());
    }

    #[test]
    fn unknown_providers_rejected() {
        assert!(entry("mock").is_err());
        assert!(entry("../../etc").is_err());
    }
}
