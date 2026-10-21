//! A minimal Gradio client (the documented HTTP API):
//! `POST {prefix}/upload` (multipart field `files`) → server paths,
//! `POST {prefix}/call/{api}` `{ data, session_hash }` → `{ event_id }`,
//! `GET {prefix}/call/{api}/{event_id}` → SSE (`complete` / `error` / `heartbeat`).
//! Gradio 5 apps serve these under `/gradio_api`; Gradio 4 at the root.

use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::error::{AppError, AppResult, ErrorCode};
use crate::net::{cancelled, transport_error, Net, Req};

pub struct Gradio<'a> {
    net: &'a Net,
    base: Url,
    prefix: &'static str,
    token: Option<String>,
    provider: &'static str,
}

/// Outputs are either a `FileData` or a component update `{ "value": FileData, "__type__": "update" }`.
pub fn file_of(v: &Value) -> Option<Value> {
    match v.get("value") {
        Some(inner) if inner.is_object() => file_of(inner),
        _ => v.get("path").and_then(Value::as_str).map(|_| v.clone()),
    }
}

pub fn session_hash() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..11].to_string()
}

impl<'a> Gradio<'a> {
    /// Connects to a Gradio app and detects its API prefix.
    pub async fn connect(net: &'a Net, base: &str, token: Option<String>, provider: &'static str) -> AppResult<Gradio<'a>> {
        let base = Url::parse(base.trim_end_matches('/')).map_err(|_| AppError::new(ErrorCode::Validation, "Invalid server address."))?;
        for prefix in ["/gradio_api", ""] {
            let g = Gradio { net, base: base.clone(), prefix, token: token.clone(), provider };
            if let Ok(resp) = net.send(&Req::get(provider).with_timeout(Duration::from_secs(25)), &g.url(&format!("{prefix}/info")), |c, u| g.auth(c.get(u.clone()))).await {
                if resp.status().is_success() {
                    return Ok(g);
                }
            }
        }
        Err(AppError::new(ErrorCode::Provider, format!("{provider} isn't responding.")).with_hint(if base.host_str().is_some_and(|h| h.ends_with(".hf.space")) {
            "The Hugging Face Space may be asleep or restarting — try again in a minute."
        } else {
            "Make sure your local server is running and the address in Settings is right."
        }))
    }

    fn url(&self, path: &str) -> Url {
        let mut u = self.base.clone();
        let joined = format!("{}{}", u.path().trim_end_matches('/'), path);
        u.set_path(&joined);
        u
    }

    fn auth(&self, rb: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.token {
            Some(t) => rb.bearer_auth(t),
            None => rb,
        }
    }

    pub async fn info(&self) -> AppResult<Value> {
        let url = self.url(&format!("{}/info", self.prefix));
        self.net.json(&Req::get(self.provider), &url, |c, u| self.auth(c.get(u.clone()))).await
    }

    /// Uploads a file and returns a `FileData` value to pass as an input.
    pub async fn upload(&self, bytes: &[u8], filename: &str, mime: &str) -> AppResult<Value> {
        let url = self.url(&format!("{}/upload", self.prefix));
        let resp = self
            .net
            .json(&Req::create(self.provider).with_timeout(Duration::from_secs(180)), &url, |c, u| {
                let part = reqwest::multipart::Part::bytes(bytes.to_vec()).file_name(filename.to_string()).mime_str(mime).expect("valid mime");
                self.auth(c.post(u.clone()).multipart(reqwest::multipart::Form::new().part("files", part)))
            })
            .await?;
        let path = resp.get(0).and_then(Value::as_str).ok_or_else(|| AppError::new(ErrorCode::Provider, format!("{} didn't accept the upload.", self.provider)))?;
        Ok(json!({ "path": path, "orig_name": filename, "meta": { "_type": "gradio.FileData" } }))
    }

    pub async fn call(&self, api: &str, data: Value, session: Option<&str>) -> AppResult<String> {
        let url = self.url(&format!("{}/call/{}", self.prefix, api.trim_start_matches('/')));
        let mut body = json!({ "data": data });
        if let Some(s) = session {
            body["session_hash"] = json!(s);
        }
        let resp = self.net.json(&Req::create(self.provider), &url, |c, u| self.auth(c.post(u.clone()).json(&body))).await?;
        resp.get("event_id").and_then(Value::as_str).map(str::to_string).ok_or_else(|| AppError::new(ErrorCode::Provider, format!("{} didn't start the job.", self.provider)))
    }

    /// Waits for the result stream to finish and returns the output list.
    pub async fn result(&self, api: &str, event_id: &str, cancel: &CancellationToken, timeout: Duration) -> AppResult<Vec<Value>> {
        let url = self.url(&format!("{}/call/{}/{}", self.prefix, api.trim_start_matches('/'), event_id));
        self.net.check(&url)?;
        let resp = tokio::select! {
            _ = cancel.cancelled() => return Err(cancelled()),
            r = self.auth(self.net.client().get(url.clone())).header("Accept", "text/event-stream").timeout(timeout).send() =>
                r.map_err(|e| transport_error(self.provider, &e, true))?,
        };
        if !resp.status().is_success() {
            return Err(crate::net::http_error(self.provider, resp.status(), None));
        }
        let mut stream = resp.bytes_stream();
        let mut buf = String::new();
        let mut event = String::new();
        loop {
            let chunk = tokio::select! {
                _ = cancel.cancelled() => return Err(cancelled()),
                c = stream.next() => c,
            };
            let Some(chunk) = chunk else {
                return Err(AppError::new(ErrorCode::Provider, format!("{} closed the connection before finishing.", self.provider)).with_hint("Try again in a moment."));
            };
            let chunk = chunk.map_err(|e| transport_error(self.provider, &e, true))?;
            buf.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(nl) = buf.find('\n') {
                let line = buf[..nl].trim_end_matches('\r').to_string();
                buf.drain(..=nl);
                if let Some(e) = line.strip_prefix("event:") {
                    event = e.trim().to_string();
                } else if let Some(d) = line.strip_prefix("data:") {
                    let d = d.trim();
                    match event.as_str() {
                        "complete" => {
                            let v: Value = serde_json::from_str(d).map_err(|_| AppError::new(ErrorCode::Provider, format!("{} returned an unreadable result.", self.provider)))?;
                            return Ok(v.as_array().cloned().unwrap_or_default());
                        }
                        "error" => return Err(self.space_error(d)),
                        _ => {}
                    }
                }
            }
        }
    }

    fn space_error(&self, raw: &str) -> AppError {
        let msg = serde_json::from_str::<Value>(raw).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_else(|| raw.trim_matches('"').to_string());
        let lower = msg.to_lowercase();
        // ZeroGPU Spaces report an exhausted quota as an error with no message.
        if msg.is_empty() || msg == "null" || lower.contains("quota") || lower.contains("gpu task aborted") || lower.contains("exceeded") {
            return AppError::new(ErrorCode::RateLimited, format!("{} is busy or out of free GPU time.", self.provider))
                .with_hint("Free GPU time is limited per person per day. Add a free Hugging Face token in Settings → Providers for more, or try again later.");
        }
        if lower.contains("out of memory") || lower.contains("cuda") {
            return AppError::new(ErrorCode::Provider, format!("{} ran out of GPU memory.", self.provider))
                .with_hint("Lower the quality (Draft uses less memory) or restart the server.");
        }
        let detail = if msg.is_empty() || msg == "null" { "the job failed".to_string() } else { msg.chars().take(240).collect() };
        AppError::new(ErrorCode::Provider, format!("{}: {detail}", self.provider)).with_hint("Try again, or use a different image.")
    }

    /// Downloads an output `FileData`, by server path via `/file=` when it has one: the `url`
    /// some Gradio 4 apps return is malformed (e.g. `/call/shape/file=…`, a 404).
    pub async fn download(&self, file: &Value, cancel: &CancellationToken) -> AppResult<Vec<u8>> {
        let file = file_of(file).unwrap_or_else(|| file.clone());
        let url = match (file.get("path").and_then(Value::as_str), file.get("url").and_then(Value::as_str)) {
            (Some(path), _) => self.url(&format!("{}/file={}", self.prefix, path)).to_string(),
            (None, Some(u)) => u.to_string(),
            (None, None) => return Err(AppError::new(ErrorCode::Provider, format!("{} returned no file.", self.provider))),
        };
        self.net.download(self.provider, &url, cancel).await
    }

    /// Names of the app's API endpoints (e.g. "/generation_all").
    pub async fn endpoints(&self) -> AppResult<Vec<String>> {
        let info = self.info().await?;
        Ok(info.get("named_endpoints").and_then(Value::as_object).map(|o| o.keys().cloned().collect()).unwrap_or_default())
    }
}
