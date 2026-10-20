mod db;
mod error;
mod files;
mod glb;
mod jobs;
mod library;
mod net;
mod paths;
mod platform;
mod protocol;
mod providers;
mod secrets;
mod settings;
mod shell;
mod state;
mod system;

use std::path::PathBuf;

use tauri::{DragDropEvent, Manager, WindowEvent};
use tauri_plugin_window_state::StateFlags;

use crate::db::Db;
use crate::jobs::JobQueue;
use crate::net::Net;
use crate::paths::AppPaths;
use crate::settings::{validate_local_url, SettingsStore};
use crate::state::AppState;

fn init_state(app: &tauri::AppHandle) -> Result<AppState, Box<dyn std::error::Error>> {
    let paths = AppPaths::resolve(app)?;
    paths.ensure()?;
    let db = Db::open(&paths.db_path)?;
    let settings = SettingsStore::load(&paths.settings_path, &paths.exports_dir);
    let net = Net::new();
    if let Ok(url) = validate_local_url(&settings.get().local_server_url) {
        net.set_local_server(&url);
    }
    Ok(AppState::new(paths, db, settings, net, JobQueue::default()))
}

pub fn run() {
    tauri::Builder::default()
        // Must be registered first: a second launch (e.g. double-clicking a .glb)
        // focuses the running window and forwards its arguments instead.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            shell::reveal_main(app);
            shell::forward_launch_args(app, argv);
        }))
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE & !StateFlags::DECORATIONS)
                .with_denylist(&["splash"])
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .register_asynchronous_uri_scheme_protocol(protocol::SCHEME, protocol::handle)
        .manage(shell::Startup::new())
        .manage(system::PendingUpdate::default())
        .setup(|app| {
            let state = init_state(app.handle())?;
            app.manage(state);
            let handle = app.handle().clone();
            app.state::<AppState>().jobs.start(handle.clone());
            // Files passed on the command line (file associations) open once the UI is ready.
            let launch: Vec<PathBuf> = std::env::args().skip(1).filter(|a| !a.starts_with('-')).map(PathBuf::from).collect();
            shell::queue_launch_paths(&handle, launch);
            shell::arm_splash_fallback(handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event {
                let app = window.app_handle().clone();
                let paths = paths.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let items = files::classify(&app.state::<AppState>(), &paths);
                    files::emit_dropped(&app, items);
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            shell::app_ready,
            shell::set_window_appearance,
            system::get_settings,
            system::update_settings,
            system::system_info,
            system::open_external,
            system::reset_app_data,
            system::list_providers,
            system::set_provider_key,
            system::clear_provider_key,
            system::test_provider,
            system::provider_usage,
            system::probe_local_server,
            system::check_for_updates,
            system::install_update,
            jobs::generate,
            jobs::refine,
            jobs::retexture,
            jobs::rig,
            jobs::list_jobs,
            jobs::cancel_job,
            jobs::retry_job,
            jobs::dismiss_job,
            jobs::clear_finished_jobs,
            jobs::estimate_cost,
            library::list_projects,
            library::get_project,
            library::rename_project,
            library::set_favorite,
            library::set_tags,
            library::duplicate_project,
            library::delete_project,
            library::delete_version,
            library::set_current_version,
            library::create_version,
            library::save_thumbnail,
            files::pick_images,
            files::stage_image_bytes,
            files::import_model,
            files::open_project_file,
            files::save_project_file,
            files::export_files,
            files::save_media,
            files::send_to_godot,
            files::pick_godot_project,
            files::pick_blender_path,
            files::pick_output_dir,
            files::detect_blender,
            files::open_in_blender,
            files::reveal,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Shift3D");
}
