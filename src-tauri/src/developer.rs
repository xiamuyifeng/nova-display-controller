use tauri::{AppHandle, Manager};

#[tauri::command]
pub fn apply_developer_mode(app: AppHandle, enabled: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window is unavailable".to_string())?;

    if !enabled && window.is_devtools_open() {
        window.close_devtools();
    }

    Ok(())
}
