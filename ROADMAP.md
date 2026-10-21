# Shift3D — Build Roadmap

> "Shift ideas into 3D." Resume point for any session: find the first unchecked box below and continue from there.
> Phase gate (every phase): `npm run tauri dev` runs · `npm run typecheck` + `npm run lint` + `cargo clippy -- -D warnings` clean · `npm test` + `cargo test` pass · commit.

## Status notes
- Environment: Node 24 LTS, Rust 1.99 (MSVC), VS Build Tools 2022, WebView2 155, GitHub CLI. GPU: RTX 3060 Laptop (6 GB).
- **Git is not installed yet** (user chose to skip for now). Commits are pending; once Git exists run `git init` and commit per phase (see "Pending commits").
- Target GitHub repo: `vcecho100-dot/idk` (currently hosts the older "Model AI" prototype). **Ask before pushing** — it replaces that repo's contents. Repo slug lives in one place: `src/lib/constants.ts` + `src-tauri/tauri.conf.json` updater endpoint.
- Deviation from brief: library DB uses `rusqlite` behind typed Rust commands instead of `tauri-plugin-sql`, so the webview can never run arbitrary SQL (stricter security, same SQLite file).

## Pending commits (run once Git is installed)
- [ ] Phase 1 commit
- [ ] Phase 2 commit
- [ ] Phase 3 commit
- [ ] Phase 4 commit
- [ ] Phase 5 commit
- [ ] Phase 6 commit
- [ ] Phase 7 commit
- [ ] Phase 8 commit

## Phase 0 — Prerequisites
- [x] Check Rust, Node LTS, VS C++ Build Tools, WebView2
- [x] Install Rust (rustup, stable-msvc), VS Build Tools (VCTools workload), GitHub CLI
- [ ] Install Git (skipped by user for now)

## Phase 1 — Foundation
- [x] Tauri 2 + React + Vite + TypeScript (strict) scaffold, npm scripts (dev, build, typecheck, lint, test, tauri)
- [x] ESLint (flat config, typescript-eslint, react-hooks), Vitest, Prettier-free consistent style
- [x] Tailwind v4 + design tokens (dark/light, accent palettes, radius, spacing, shadows, motion) — no hardcoded colors in components
- [x] Geist Sans + Geist Mono bundled locally
- [x] UI kit (shadcn-style on Radix): Button, IconButton, Tooltip, Dialog, Popover, DropdownMenu, ContextMenu, Tabs, Slider, Switch, Input, Textarea, Select, Kbd, Badge, Skeleton, Progress, Separator, SegmentedControl (Command → Phase 7 palette)
- [x] Brand: logo SVG (half wireframe / half solid cube, gradient), wordmark, `<Logo/>` component
- [x] App icons generated from the mark (`npm run tauri icon`)
- [x] Frameless window, custom title bar (logo, project name, jobs indicator, window controls), Mica on Windows 11 (only when supported)
- [x] Splash window → main window shown when UI is ready; remembered size/position; single instance
- [x] Reduced-motion support, toasts (sonner), app router (Home / Studio / Library / Settings)
- [x] Browser engine (full in-browser implementation of the backend API) — powers `npm run dev` previews, tests and the web demo
- [x] Strict CSP, minimal capabilities (custom app-command permission set; webview has no fs/shell/http/sql)
- [x] Screenshot + self-critique pass (fixed title-bar search wrap, segmented label wrap)

## Phase 2 — Viewer
- [ ] R3F viewport: orbit/pan/zoom (damped), infinite grid, contact shadows, bloom, SSAO (N8AO), 60fps target
- [ ] Lighting presets (Studio, Soft, Sunset, Night, Neon, Outdoor) — procedural environments, no CDN
- [ ] Backgrounds (gradient, solid, grid-only, transparent)
- [ ] Render modes: Textured, Clay, Wireframe, Normals, UV checker, Texture maps (per-map view)
- [ ] Floating toolbar: render modes, lighting, background, turntable, screenshot, fullscreen, reset camera
- [ ] Stats overlay: triangles, vertices, materials, texture resolution, file size
- [ ] "The Shift": point cloud gathers during generation → wireframe → clay → textured reveal (~1s)
- [ ] Compare slider (scissor split, draggable divider) for any two versions
- [ ] Quality presets (Low/Medium/High/Ultra) + FPS cap; auto-tuned for 6 GB GPUs; adaptive DPR
- [ ] Screenshot to PNG; turntable auto-rotate (Space)

## Phase 3 — Engine (Rust)  ← built early (the desktop UI needs it to boot)
- [x] Paths: Documents/Shift3D/{Projects,Exports}; AppData for DB + settings + staging
- [x] SQLite (rusqlite, WAL, migrations): projects, versions, jobs, usage (+ project.json manifest per folder)
- [x] `Provider` trait: create_task, get_status (status, progress, stage, model_url, error), cancel, estimate_cost
- [x] Mock provider (default, no key): ~8s staged progress, keyword-picked sample GLB (embedded), variants, refine/retexture/rig
- [x] Tripo adapter — v3 API from the official SDK (generation, texture, rig-check/rig/retarget, files, balance)
- [x] Meshy adapter — docs.meshy.ai (text preview→refine, image, multi-image, retexture, rigging, animations, balance)
- [x] fal.ai adapter — queue API; TRELLIS, TRELLIS multi, Hunyuan3D v2 (textured), FLUX schnell for text
- [x] Local server adapter — Hunyuan3D-2 api_server (2mini, 6 GB) / gradio_app / TRELLIS gradio; auto-detect via probe
- [x] 6 GB profile: shape-only generation + Shift3D image-projection texturing (front/back mirrored)
- [x] Free web fallback — Hugging Face Spaces (FLUX.1-schnell → Hunyuan3D-2) via a Gradio client; auto-reroute when local is offline
- [x] GPU/VRAM detection (DXGI)
- [x] Secure key storage via Windows Credential Manager (`keyring`); keys never reach the webview
- [x] Network allowlist (provider domains + user's local server URL only), timeouts, retries w/ backoff (no double-billing), offline detection, friendly errors
- [x] Persistent job queue (concurrency 4, cancel, retry, resume after restart, synthetic progress); download models immediately
- [x] File validation: size limits, GLB/glTF magic checks, no path traversal, zip-bomb protection for .shift3d
- [x] Scoped file access: s3d:// protocol by ID only; grant tokens for dropped/opened files; Rust-side dialogs
- [x] Native notification when a job finishes and the app is unfocused
- [x] cargo tests: 43 passing (validation, zip bomb, traversal, mock, allowlist, settings guard, projection, db)
- [ ] Live verification against real provider keys (needs your keys — mock + free Space can be tested without)

## Phase 4 — Studio
- [x] Left/right panels (model panel collapses to a toggle on narrow windows, hidden in focus mode), bottom version timeline — drag-resizing still to do
- [x] Create panel: Text / Image / Multi-view tabs
- [x] Text: prompt, Enhance prompt, suggestion chips
- [x] Image: drag-drop / picker with preview; Multi-view: front/side/back slots
- [x] Style cards with preview images (Realistic, Stylized, Cartoon, Low-poly, Voxel, Sculpture)
- [x] Advanced: negative prompt, quality, face limit, PBR, seed
- [x] Cost estimate before generating; Generate (Ctrl+Enter)
- [x] Generate 4 variants → 2x2 picker
- [x] Versions: auto thumbnails, click to view, branch badges, compare any two (right-click)
- [x] Undo/redo (Ctrl+Z / Ctrl+Y) for version switches and material edits (zundo)
- [ ] Jobs popover: running/queued with progress, cancel, retry

## Phase 5 — Tools
- [ ] Refine (draft → high quality) via provider
- [ ] Retexture (new texture prompt, same shape) via provider; local fallback in mock
- [ ] Stylize (local, worker): Voxel, Low-poly, Smooth
- [ ] Optimize: decimate slider with live triangle count, Draco / meshopt compression
- [ ] Auto-rig + animation presets (idle/walk/run) where provider supports; disabled with reason otherwise
- [ ] Transform: real-world scale, center, snap to ground, rotate, mirror
- [ ] Materials: texture map strip, PBR sliders (tint, roughness, metalness, emissive), swap texture with own image
- [ ] Compare slider wired to refine / retexture / optimize results

## Phase 6 — Export & integrations
- [ ] Formats: GLB, glTF, OBJ (+MTL), STL, USDZ via native Save dialog (Rust-side)
- [ ] Engine presets: Godot, Unity, Unreal, Blender, 3D print
- [ ] Send to Godot project (pick folder once → res://models/)
- [ ] Open in Blender (auto-detect path), Show in Explorer
- [ ] Turntable MP4 (WebCodecs + mp4-muxer) and GIF (gifenc)
- [ ] .shift3d project file (zip of versions + metadata): save/open, file associations (.glb, .gltf, .shift3d)
- [ ] Drag-and-drop from Explorer anywhere

## Phase 7 — Home, Library, Settings, Onboarding
- [ ] Home: big prompt box, recent projects grid, templates row, Open file
- [ ] Library: grid, search, filters, sort, favorites, tags, rename, duplicate, delete-to-Recycle-Bin
- [ ] Settings: providers (key entry, Test connection, usage stats, local server URL), output folder, defaults, Godot/Blender paths, viewport quality + FPS cap, theme + accent, updates (check now, channel), privacy (no telemetry, reset all data), About (version, licenses, credits)
- [ ] Onboarding: theme → provider/key or offline demo → studio tooltip tour; skippable
- [ ] Command palette (Ctrl+K) covering every action; shortcut cheatsheet (?)
- [ ] All keyboard shortcuts wired

## Phase 8 — Ship
- [ ] NSIS .exe + .msi with icon, version info, publisher
- [ ] Signed auto-updates (tauri-plugin-updater) from GitHub Releases; key generated outside repo; stable/beta channels
- [ ] GitHub Actions: CI (typecheck, lint, test, clippy, cargo test, cargo audit, npm audit) + release on `v*` tags (tauri-action, notes, SHA256 checksums)
- [ ] Optional code signing (PFX or Azure Trusted Signing) via secrets
- [ ] Web demo build → GitHub Pages (viewer, local tools, offline demo; no keys in browser)
- [ ] README (banner, badges, hero GIF placeholder, features, download, build guide, providers, security, shortcuts, roadmap, credits incl. Khronos samples, license)
- [ ] LICENSE (MIT), SECURITY.md, CONTRIBUTING.md, CHANGELOG.md, .gitignore, issue templates
- [ ] Final QA: offline flow Home → generate → refine → optimize → export → reopen from Library; perf budgets; security checklist
