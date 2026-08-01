use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Manager,
};

use crate::{device::DeviceState, diagnostics};

const SHOW_MENU_ID: &str = "show-main-window";
const EXIT_MENU_ID: &str = "exit-application";

pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn setup(app: &mut App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, SHOW_MENU_ID, "显示主窗口 / Show", true, None::<&str>)?;
    let exit = MenuItem::with_id(app, EXIT_MENU_ID, "退出程序 / Exit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &exit])?;
    let mut builder = TrayIconBuilder::with_id("nova-display-tray")
        .tooltip("Nova Display Controller")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            if event.id() == SHOW_MENU_ID {
                show_main_window(app);
            } else if event.id() == EXIT_MENU_ID {
                exit_application(app);
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn exit_application(app: &AppHandle) {
    let restore_result = app.state::<DeviceState>().release_to_base_ui();
    match restore_result {
        Ok(true) => {
            diagnostics::write_entry(app, "info", "Official base-station UI restored before exit")
        }
        Ok(false) => diagnostics::write_entry(
            app,
            "info",
            "Application exit requested without a connected device",
        ),
        Err(error) => diagnostics::write_entry(
            app,
            "warn",
            &format!("Failed to restore official base-station UI before exit: {error}"),
        ),
    }
    app.exit(0);
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    exit_application(&app);
}
