//! All network traffic goes through here: a hardcoded allowlist of provider domains
//! (plus the user's own local server), timeouts, retries with backoff, offline
//! detection and friendly errors. API keys are attached per request and never logged.

use std::sync::RwLock;
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::{Client, RequestBuilder, Response, StatusCode};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::error::{AppError, AppResult, ErrorCode};

/// Exact API hosts and provider-owned domains (a leading `.` means "this domain or any subdomain").
const ALLOWED: &[&str] = &[
    // Tripo (v3 global API + its CDN)
    "openapi.tripo3d.ai",
    ".tripo3d.ai",
    ".tripo3d.com",
    // Meshy
    "api.meshy.ai",
    ".meshy.ai",
    // fal.ai (queue + result files)
    "queue.fal.run",
    "fal.run",
    ".fal.run",
    "fal.media",
    ".fal.media",
    // Hugging Face (token check) and the specific public Spaces Shift3D uses
    "huggingface.co",
    "tencent-hunyuan3d-2.hf.space",
    "black-forest-labs-flux-1-schnell.hf.space",
    "trellis-community-trellis.hf.space",
];

/// fal also serves some result files from this Google Cloud bucket path.
const ALLOWED_PREFIXES: &[(&str, &str)] = &[("storage.googleapis.com", "/falserverless/")];

pub const MAX_DOWNLOAD_BYTES: u64 = 256 * 1024 * 1024;

pub struct Net {
    http: Client,
    local: RwLock<Option<(String, Option<u16>)>>,
}

pub struct Req {
    pub provider: &'static str,
    /// Safe to replay after an ambiguous failure (GETs). Task-creation POSTs are not,
    /// because providers bill per submission.
    pub idempotent: bool,
    pub timeout: Duration,
}

impl Req {
    pub fn get(provider: &'static str) -> Self {
        Self { provider, idempotent: true, timeout: Duration::from_secs(45) }
    }
    pub fn create(provider: &'static str) -> Self {
        Self { provider, idempotent: false, timeout: Duration::from_secs(90) }
    }
    pub fn with_timeout(mut self, t: Duration) -> Self {
        self.timeout = t;
        self
    }
}

pub fn host_allowed(url: &Url, local: Option<&(String, Option<u16>)>) -> bool {
    let Some(host) = url.host_str() else { return false };
    let host = host.to_ascii_lowercase();
    if let Some((lh, lp)) = local {
        if &host == lh && url.port_or_known_default() == lp.or(url.port_or_known_default()) && matches!(url.scheme(), "http" | "https") {
            return true;
        }
    }
    if url.scheme() != "https" {
        return false;
    }
    if ALLOWED.iter().any(|a| match a.strip_prefix('.') {
        Some(domain) => host == domain || host.ends_with(&format!(".{domain}")),
        None => host == *a,
    }) {
        return true;
    }
    ALLOWED_PREFIXES.iter().any(|(h, p)| host == *h && url.path().starts_with(p))
}

impl Default for Net {
    fn default() -> Self {
        Self::new()
    }
}

impl Net {
    pub fn new() -> Self {
        let http = Client::builder()
            .user_agent(concat!("Shift3D/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(15))
            .pool_idle_timeout(Duration::from_secs(60))
            // Redirects are followed manually so every hop is checked against the allowlist.
            .redirect(reqwest::redirect::Policy::none())
            .https_only(false)
            .build()
            .expect("HTTP client");
        Self { http, local: RwLock::new(None) }
    }

    /// Allows the user's own local generation server (scheme/host/port from Settings).
    pub fn set_local_server(&self, url: &Url) {
        let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
        *self.local.write().expect("net lock") = Some((host, url.port_or_known_default()));
    }

    pub fn check(&self, url: &Url) -> AppResult<()> {
        let local = self.local.read().expect("net lock").clone();
        if host_allowed(url, local.as_ref()) {
            Ok(())
        } else {
            log::warn!("blocked request to non-allowlisted host {:?}", url.host_str());
            Err(AppError::new(
                ErrorCode::Network,
                format!("Blocked a connection to {} — it isn't on Shift3D's list of trusted provider domains.", url.host_str().unwrap_or("an unknown host")),
            )
            .with_hint("This protects your keys and files. If a provider moved its servers, update Shift3D."))
        }
    }

    pub fn client(&self) -> &Client {
        &self.http
    }

    /// Sends a request built by `build` (called once per attempt), with retries where safe.
    pub async fn send(&self, req: &Req, url: &Url, build: impl Fn(&Client, &Url) -> RequestBuilder) -> AppResult<Response> {
        self.check(url)?;
        let attempts = 3;
        let mut last_err = None;
        for attempt in 1..=attempts {
            let result = build(&self.http, url).timeout(req.timeout).send().await;
            match result {
                Ok(resp) => {
                    let status = resp.status();
                    if status.is_redirection() {
                        return Err(AppError::new(ErrorCode::Provider, format!("{} redirected unexpectedly.", req.provider)));
                    }
                    let clean_retry = matches!(status, StatusCode::TOO_MANY_REQUESTS | StatusCode::SERVICE_UNAVAILABLE);
                    let ambiguous_retry = req.idempotent && (status.is_server_error() || status == StatusCode::REQUEST_TIMEOUT);
                    if (clean_retry || ambiguous_retry) && attempt < attempts {
                        let wait = retry_after(&resp).unwrap_or_else(|| backoff(attempt));
                        tokio::time::sleep(wait).await;
                        continue;
                    }
                    return Ok(resp);
                }
                Err(e) => {
                    // Connection never established → the server can't have acted on it.
                    let clean = e.is_connect();
                    if (clean || req.idempotent) && attempt < attempts {
                        last_err = Some(e);
                        tokio::time::sleep(backoff(attempt)).await;
                        continue;
                    }
                    return Err(transport_error(req.provider, &e, req.idempotent));
                }
            }
        }
        Err(last_err.map(|e| transport_error(req.provider, &e, req.idempotent)).unwrap_or_else(|| AppError::new(ErrorCode::Network, "Network request failed.")))
    }

    /// Sends and parses JSON, mapping HTTP errors to friendly messages.
    pub async fn json(&self, req: &Req, url: &Url, build: impl Fn(&Client, &Url) -> RequestBuilder) -> AppResult<serde_json::Value> {
        let resp = self.send(req, url, build).await?;
        let status = resp.status();
        let body = resp.bytes().await.map_err(|e| transport_error(req.provider, &e, req.idempotent))?;
        let parsed: Option<serde_json::Value> = serde_json::from_slice(&body).ok();
        if !status.is_success() {
            return Err(http_error(req.provider, status, parsed.as_ref()));
        }
        parsed.ok_or_else(|| AppError::new(ErrorCode::Provider, format!("{} returned an unreadable response.", req.provider)).with_hint("Try again in a moment."))
    }

    /// Streams a file to memory with a size cap, following allowlisted redirects only.
    pub async fn download(&self, provider: &'static str, url: &str, cancel: &CancellationToken) -> AppResult<Vec<u8>> {
        let mut current = Url::parse(url).map_err(|_| AppError::new(ErrorCode::Provider, format!("{provider} returned an invalid download link.")))?;
        for _ in 0..5 {
            self.check(&current)?;
            let resp = tokio::select! {
                _ = cancel.cancelled() => return Err(cancelled()),
                r = self.http.get(current.clone()).timeout(Duration::from_secs(600)).send() => r.map_err(|e| transport_error(provider, &e, true))?,
            };
            if resp.status().is_redirection() {
                let loc = resp.headers().get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok()).unwrap_or_default();
                current = current.join(loc).map_err(|_| AppError::new(ErrorCode::Provider, "Bad redirect while downloading."))?;
                continue;
            }
            if !resp.status().is_success() {
                return Err(if resp.status() == StatusCode::FORBIDDEN || resp.status() == StatusCode::NOT_FOUND {
                    AppError::new(ErrorCode::Provider, format!("The {provider} download link expired before it could be saved."))
                        .with_hint("Retry the job — Shift3D downloads results the moment they're ready.")
                } else {
                    http_error(provider, resp.status(), None)
                });
            }
            if resp.content_length().is_some_and(|l| l > MAX_DOWNLOAD_BYTES) {
                return Err(too_big());
            }
            let mut out = Vec::new();
            let mut stream = resp.bytes_stream();
            loop {
                let chunk = tokio::select! {
                    _ = cancel.cancelled() => return Err(cancelled()),
                    c = stream.next() => c,
                };
                let Some(chunk) = chunk else { break };
                let chunk = chunk.map_err(|e| transport_error(provider, &e, true))?;
                out.extend_from_slice(&chunk);
                if out.len() as u64 > MAX_DOWNLOAD_BYTES {
                    return Err(too_big());
                }
            }
            return Ok(out);
        }
        Err(AppError::new(ErrorCode::Provider, "Too many redirects while downloading."))
    }
}

fn too_big() -> AppError {
    AppError::new(ErrorCode::Validation, "The generated model is larger than 256 MB.").with_hint("Lower the face limit and try again.")
}

pub fn cancelled() -> AppError {
    AppError::new(ErrorCode::Cancelled, "Cancelled.")
}

fn backoff(attempt: u32) -> Duration {
    let base = 800u64 * 2u64.pow(attempt.saturating_sub(1));
    Duration::from_millis(base.min(8000) + rand::random::<u64>() % 250)
}

fn retry_after(resp: &Response) -> Option<Duration> {
    let secs: f64 = resp.headers().get(reqwest::header::RETRY_AFTER)?.to_str().ok()?.parse().ok()?;
    (secs.is_finite() && secs >= 0.0).then(|| Duration::from_millis((secs * 1000.0).min(30_000.0) as u64))
}

pub fn transport_error(provider: &str, e: &reqwest::Error, idempotent: bool) -> AppError {
    if e.is_timeout() {
        let err = AppError::new(ErrorCode::Timeout, format!("{provider} took too long to respond."));
        return if idempotent {
            err.with_hint("Check your connection and try again.")
        } else {
            err.with_hint("The request may still have gone through — check the Jobs list before retrying so you aren't charged twice.")
        };
    }
    if e.is_connect() {
        let msg = e.to_string().to_lowercase();
        if msg.contains("dns") || msg.contains("resolve") || msg.contains("no such host") || msg.contains("lookup") {
            return AppError::new(ErrorCode::Offline, "You appear to be offline.")
                .with_hint("Reconnect to the internet — or switch to the Offline demo or a Local GPU provider.");
        }
        return AppError::new(ErrorCode::Network, format!("Couldn't connect to {provider}."))
            .with_hint("Check your internet connection or firewall, then try again.");
    }
    AppError::new(ErrorCode::Network, format!("The connection to {provider} was interrupted.")).with_hint("Try again in a moment.")
}

/// Extracts the provider's own error text from common JSON shapes.
fn provider_message(body: Option<&serde_json::Value>) -> Option<String> {
    let b = body?;
    for key in ["message", "detail", "error", "msg"] {
        match b.get(key) {
            Some(serde_json::Value::String(s)) if !s.is_empty() => return Some(s.chars().take(300).collect()),
            Some(serde_json::Value::Object(o)) => {
                if let Some(serde_json::Value::String(s)) = o.get("message") {
                    return Some(s.chars().take(300).collect());
                }
            }
            _ => {}
        }
    }
    None
}

pub fn http_error(provider: &str, status: StatusCode, body: Option<&serde_json::Value>) -> AppError {
    let detail = provider_message(body);
    let with = |base: String| match &detail {
        Some(d) => format!("{base} ({d})"),
        None => base,
    };
    match status.as_u16() {
        401 | 403 => AppError::new(ErrorCode::Auth, format!("{provider} rejected your API key."))
            .with_hint("Open Settings → Providers, paste a valid key and press Test connection."),
        402 => AppError::new(ErrorCode::Credits, format!("Your {provider} account is out of credits."))
            .with_hint("Top up on the provider's dashboard, or switch to the Offline demo or Local GPU."),
        404 => AppError::new(ErrorCode::NotFound, with(format!("{provider} couldn't find that task."))),
        408 => AppError::new(ErrorCode::Timeout, format!("{provider} timed out.")).with_hint("Try again."),
        409 => AppError::new(ErrorCode::Provider, with(format!("{provider} can't do that right now."))),
        413 => AppError::new(ErrorCode::Validation, format!("That file is too large for {provider}.")).with_hint("Use a smaller image or model."),
        400 | 422 => AppError::new(ErrorCode::Validation, with(format!("{provider} didn't accept the request.")))
            .with_hint("Adjust the prompt or options and try again."),
        429 => AppError::new(ErrorCode::RateLimited, format!("{provider} is rate-limiting requests."))
            .with_hint("Wait a minute, or run fewer jobs at once."),
        500..=599 => AppError::new(ErrorCode::Provider, format!("{provider} is having trouble right now."))
            .with_hint("This is on their side — retry in a few minutes."),
        _ => AppError::new(ErrorCode::Provider, with(format!("{provider} returned HTTP {}.", status.as_u16()))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(u: &str) -> bool {
        host_allowed(&Url::parse(u).unwrap(), None)
    }

    #[test]
    fn allowlist() {
        assert!(ok("https://openapi.tripo3d.ai/v3/tasks/abc"));
        assert!(ok("https://tripo-data.rg1.data.tripo3d.com/x.glb"));
        assert!(ok("https://api.meshy.ai/openapi/v2/text-to-3d"));
        assert!(ok("https://assets.meshy.ai/abc/model.glb"));
        assert!(ok("https://queue.fal.run/fal-ai/trellis"));
        assert!(ok("https://v3.fal.media/files/a/b.glb"));
        assert!(ok("https://storage.googleapis.com/falserverless/x.glb"));
        assert!(ok("https://tencent-hunyuan3d-2.hf.space/call/generation_all"));
        assert!(!ok("https://storage.googleapis.com/evil/x.glb"));
        assert!(!ok("https://evil.com/steal"));
        assert!(!ok("https://meshy.ai.evil.com/x"));
        assert!(!ok("https://notmeshy.ai/x"));
        assert!(!ok("http://api.meshy.ai/insecure"));
        assert!(!ok("https://random-user-space.hf.space/x"));
    }

    #[test]
    fn local_server_is_exact() {
        let local = Some(("127.0.0.1".to_string(), Some(8081)));
        assert!(host_allowed(&Url::parse("http://127.0.0.1:8081/send").unwrap(), local.as_ref()));
        assert!(!host_allowed(&Url::parse("http://127.0.0.1:9999/send").unwrap(), local.as_ref()));
        assert!(!host_allowed(&Url::parse("http://localhost:8081/send").unwrap(), local.as_ref()));
    }

    #[test]
    fn errors_are_friendly() {
        let e = http_error("Tripo", StatusCode::UNAUTHORIZED, None);
        assert_eq!(e.code, ErrorCode::Auth);
        assert!(e.hint.unwrap().contains("Settings"));
        let body = serde_json::json!({ "message": "prompt too long" });
        let e = http_error("Meshy", StatusCode::BAD_REQUEST, Some(&body));
        assert!(e.message.contains("prompt too long"));
    }
}
