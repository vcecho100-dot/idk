# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Use GitHub's
[private vulnerability reporting](https://github.com/vcecho100-dot/idk/security/advisories/new)
instead. You'll get a reply within a few days; fixes ship as a new release, and
you'll be credited unless you'd rather not be.

## Supported versions

Only the latest release receives security fixes. Shift3D updates itself from
signed GitHub releases.

## Design

- **Secrets:** provider API keys are stored only in Windows Credential Manager
  (`keyring`). They are never written to disk by Shift3D, logged, or sent to the
  web view, which can only learn whether a key is configured.
- **Network:** every request is made by the Rust engine, restricted to a hardcoded
  allowlist of provider domains plus the user's own local server URL. Redirects
  and downloads are checked against the same list. Task-creation requests are
  never replayed after an ambiguous failure, so a retry can't bill you twice.
- **Web view privileges:** Tauri capabilities grant only window controls, event
  listening and Shift3D's own typed commands. There is no file-system, shell,
  HTTP or SQL access from the web view. Library files are served over the
  `s3d://` protocol by ID only; user-chosen files (drops, file associations,
  dialogs) become single-use grant tokens. Paths that could grant reach — the
  export folder, the Godot project and the Blender executable — can only be set
  through native pickers.
- **Content Security Policy:** `default-src 'self'`, no remote scripts, fonts or
  CDNs, `object-src 'none'`, `frame-ancestors 'none'`. Inline *styles* are
  allowed (UI libraries inject them); inline *scripts* are not.
- **File validation:** size caps, GLB magic/structure checks, glTF 2.0 only,
  `.gltf` sidecars must be plain relative paths inside the file's folder, and
  `.shift3d` archives are read with entry-count, per-entry, total-size and
  compression-ratio limits on the real decompressed bytes, with an allowlist of
  entry names.
- **No telemetry.** Shift3D makes no analytics or tracking requests of any kind.
- **Supply chain:** CI runs `cargo audit` and `npm audit`; release builds are
  signed for the updater with a key that never touches the repository.
