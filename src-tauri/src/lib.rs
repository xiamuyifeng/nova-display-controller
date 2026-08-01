mod developer;
mod device;
mod diagnostics;
mod display;
mod gamesense;
mod migration;
mod provider;
mod startup;
mod tray;

use std::sync::Mutex;
use sysinfo::System;
use tauri::Manager;

pub struct MetricsState(pub Mutex<Option<System>>);

impl MetricsState {
    fn new() -> Self {
        Self(Mutex::new(None))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    migration::migrate_legacy_data();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if !args.iter().any(|arg| arg == "--hidden") {
                tray::show_main_window(app);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(device::DeviceState::new())
        .manage(provider::ProviderState::new())
        .manage(MetricsState::new())
        .setup(|app| {
            tray::setup(app)?;
            let hidden = std::env::args().any(|argument| argument == "--hidden");
            if hidden {
                if let Some(window) = app.get_webview_window("main") {
                    window.hide()?;
                }
            } else {
                tray::show_main_window(app.handle());
            }
            diagnostics::write_entry(
                app.handle(),
                "info",
                if hidden {
                    "Application started in the system tray"
                } else {
                    "Application started with the main window visible"
                },
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            device::list_devices,
            device::connect,
            device::disconnect,
            device::get_status,
            device::set_brightness,
            device::get_system_metrics,
            device::get_media_info,
            display::send_image,
            display::send_frame,
            display::send_text,
            display::stop_display,
            gamesense::get_gamesense_status,
            gamesense::send_gamesense_probe,
            gamesense::remove_gamesense_probe,
            provider::install_provider_extension,
            provider::remove_provider_extension,
            provider::stop_provider_extension,
            provider::get_provider_statuses,
            provider::get_provider_logs,
            provider::tick_provider_extension,
            startup::get_startup_status,
            startup::set_launch_on_startup,
            developer::apply_developer_mode,
            diagnostics::get_diagnostic_settings,
            diagnostics::set_diagnostic_enabled,
            diagnostics::set_diagnostic_directory,
            diagnostics::write_diagnostic_log,
            diagnostics::open_log_directory,
            tray::quit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error running tauri application");
}
