//! The `s3d://` protocol serves library files to the webview by ID only:
//!
//!   /model/<version-id>.glb   → the version's GLB
//!   /thumb/<version-id>.webp  → the version's thumbnail
//!   /staged/<image-id>        → a staged input image (preview)
//!
//! The webview never sees or supplies file-system paths, so it can't read anything
//! outside the library even if its content were compromised.

use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use crate::paths::safe_id;
use crate::state::AppState;

pub const SCHEME: &str = "s3d";

fn respond(status: StatusCode, mime: &str, body: Vec<u8>, cache: bool) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CACHE_CONTROL, if cache { "private, max-age=31536000, immutable" } else { "no-store" })
        .header("X-Content-Type-Options", "nosniff")
        .body(body)
        .expect("valid response")
}

fn not_found() -> Response<Vec<u8>> {
    respond(StatusCode::NOT_FOUND, "text/plain", b"not found".to_vec(), false)
}

fn resolve<R: Runtime>(app: &tauri::AppHandle<R>, path: &str) -> Response<Vec<u8>> {
    let st = app.state::<AppState>();
    let mut parts = path.trim_start_matches('/').splitn(2, '/');
    let (Some(kind), Some(file)) = (parts.next(), parts.next()) else { return not_found() };
    match kind {
        "model" => {
            let Some(id) = file.strip_suffix(".glb").and_then(|i| safe_id(i).ok()) else { return not_found() };
            let Ok(v) = st.db.version(id) else { return not_found() };
            let Ok(p) = st.paths.version_model(&v.project_id, &v.id) else { return not_found() };
            match std::fs::read(p) {
                // Versions are immutable once written, so they can be cached forever.
                Ok(bytes) => respond(StatusCode::OK, "model/gltf-binary", bytes, true),
                Err(_) => not_found(),
            }
        }
        "thumb" => {
            let Some(id) = file.strip_suffix(".webp").and_then(|i| safe_id(i).ok()) else { return not_found() };
            let Ok(v) = st.db.version(id) else { return not_found() };
            let Ok(p) = st.paths.version_thumb(&v.project_id, &v.id) else { return not_found() };
            match std::fs::read(p) {
                Ok(bytes) => {
                    let mime = crate::glb::image_mime(&bytes).unwrap_or("image/webp");
                    respond(StatusCode::OK, mime, bytes, false)
                }
                Err(_) => not_found(),
            }
        }
        "staged" => {
            let Ok(id) = safe_id(file) else { return not_found() };
            let Ok(p) = st.paths.staged_image(id) else { return not_found() };
            match std::fs::read(p) {
                Ok(bytes) => match crate::glb::image_mime(&bytes) {
                    Some(mime) => respond(StatusCode::OK, mime, bytes, true),
                    None => not_found(),
                },
                Err(_) => not_found(),
            }
        }
        _ => not_found(),
    }
}

pub fn handle<R: Runtime>(ctx: UriSchemeContext<'_, R>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let app = ctx.app_handle().clone();
    let path = request.uri().path().to_string();
    if request.method() != tauri::http::Method::GET {
        responder.respond(respond(StatusCode::METHOD_NOT_ALLOWED, "text/plain", vec![], false));
        return;
    }
    // File reads happen off the main thread so big models never stall the UI.
    tauri::async_runtime::spawn_blocking(move || responder.respond(resolve(&app, &path)));
}
