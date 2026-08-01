use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const LOG_FILE: &str = "nova-display.log";
const OLD_LOG_FILE: &str = "nova-display.old.log";
const SETTINGS_FILE: &str = "diagnostics.json";
const MAX_LOG_BYTES: u64 = 512 * 1024;
const MAX_MESSAGE_CHARS: usize = 8 * 1024;
static LOG_LOCK: Mutex<()> = Mutex::new(());

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredSettings {
    enabled: bool,
    directory: Option<String>,
}

impl Default for StoredSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            directory: None,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticSettings {
    enabled: bool,
    directory: String,
    default_directory: String,
    is_default: bool,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(SETTINGS_FILE))
        .map_err(|error| error.to_string())
}

fn default_log_directory() -> Result<PathBuf, String> {
    std::env::current_exe()
        .map_err(|error| error.to_string())?
        .parent()
        .map(|directory| directory.join("logs"))
        .ok_or_else(|| "Unable to resolve the application directory".to_string())
}

fn read_settings(app: &AppHandle) -> Result<StoredSettings, String> {
    let path = settings_path(app)?;
    if !path.exists() {
        return Ok(StoredSettings::default());
    }
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&content).map_err(|error| error.to_string())
}

fn write_settings(app: &AppHandle, settings: &StoredSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let content = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    fs::write(path, content).map_err(|error| error.to_string())
}

fn selected_log_directory(settings: &StoredSettings) -> Result<PathBuf, String> {
    settings
        .directory
        .as_deref()
        .filter(|directory| !directory.trim().is_empty())
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(default_log_directory)
}

#[cfg(target_os = "windows")]
fn sync_uninstaller_log_directory(directory: &std::path::Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    const KEY: &str = r"HKCU\Software\xiamuyifeng\Nova Display Controller";
    let status = Command::new("reg")
        .args([
            "add",
            KEY,
            "/v",
            "DiagnosticLogDirectory",
            "/t",
            "REG_SZ",
            "/d",
            &directory.to_string_lossy(),
            "/f",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|error| error.to_string())?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| "Unable to register the diagnostic log directory".to_string())
}

#[cfg(not(target_os = "windows"))]
fn sync_uninstaller_log_directory(_directory: &std::path::Path) -> Result<(), String> {
    Ok(())
}

fn resolved_settings(app: &AppHandle) -> Result<(StoredSettings, PathBuf, PathBuf), String> {
    let settings = read_settings(app)?;
    let directory = selected_log_directory(&settings)?;
    let default_directory = default_log_directory()?;
    Ok((settings, directory, default_directory))
}

fn public_settings(app: &AppHandle) -> Result<DiagnosticSettings, String> {
    let (settings, directory, default_directory) = resolved_settings(app)?;
    Ok(DiagnosticSettings {
        enabled: settings.enabled,
        directory: directory.to_string_lossy().into_owned(),
        default_directory: default_directory.to_string_lossy().into_owned(),
        is_default: settings.directory.is_none(),
    })
}

fn normalized_level(level: &str) -> &'static str {
    match level.to_ascii_lowercase().as_str() {
        "error" => "ERROR",
        "warn" | "warning" => "WARN",
        _ => "INFO",
    }
}

fn normalized_message(message: &str) -> String {
    message
        .chars()
        .take(MAX_MESSAGE_CHARS)
        .map(|character| match character {
            '\r' | '\n' => ' ',
            other => other,
        })
        .collect()
}

fn append_entry(app: &AppHandle, level: &str, message: &str) -> Result<(), String> {
    let _guard = LOG_LOCK
        .lock()
        .map_err(|_| "Diagnostic log lock is poisoned".to_string())?;
    let (settings, directory, _) = resolved_settings(app)?;
    if !settings.enabled {
        return Ok(());
    }
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let current = directory.join(LOG_FILE);
    if current
        .metadata()
        .map(|metadata| metadata.len() >= MAX_LOG_BYTES)
        .unwrap_or(false)
    {
        let old = directory.join(OLD_LOG_FILE);
        if old.exists() {
            fs::remove_file(&old).map_err(|error| error.to_string())?;
        }
        fs::rename(&current, old).map_err(|error| error.to_string())?;
    }
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(current)
        .map_err(|error| error.to_string())?;
    writeln!(
        file,
        "[{timestamp}] [{}] {}",
        normalized_level(level),
        normalized_message(message)
    )
    .map_err(|error| error.to_string())
}

pub fn write_entry(app: &AppHandle, level: &str, message: &str) {
    let _ = append_entry(app, level, message);
}

#[tauri::command]
pub async fn get_diagnostic_settings(app: AppHandle) -> Result<DiagnosticSettings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = public_settings(&app)?;
        let _ = sync_uninstaller_log_directory(std::path::Path::new(&settings.directory));
        Ok(settings)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn set_diagnostic_enabled(
    app: AppHandle,
    enabled: bool,
) -> Result<DiagnosticSettings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut settings = read_settings(&app)?;
        settings.enabled = enabled;
        write_settings(&app, &settings)?;
        let result = public_settings(&app)?;
        if enabled {
            write_entry(&app, "info", "Diagnostic logging enabled");
        }
        Ok(result)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn set_diagnostic_directory(
    app: AppHandle,
    directory: Option<String>,
) -> Result<DiagnosticSettings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut settings = read_settings(&app)?;
        settings.directory = match directory.map(|value| value.trim().to_string()) {
            Some(value) if !value.is_empty() => {
                let path = PathBuf::from(&value);
                if !path.is_absolute() {
                    return Err("Diagnostic log directory must be an absolute path".to_string());
                }
                fs::create_dir_all(&path).map_err(|error| error.to_string())?;
                Some(path.to_string_lossy().into_owned())
            }
            _ => None,
        };
        write_settings(&app, &settings)?;
        let result = public_settings(&app)?;
        let _ = sync_uninstaller_log_directory(std::path::Path::new(&result.directory));
        write_entry(&app, "info", "Diagnostic log directory updated");
        Ok(result)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn write_diagnostic_log(
    app: AppHandle,
    level: String,
    message: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || append_entry(&app, &level, &message))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(target_os = "windows")]
fn open_directory(path: &PathBuf) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    Command::new("explorer")
        .arg(path)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "linux")]
fn open_directory(path: &PathBuf) -> Result<(), String> {
    Command::new("xdg-open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
fn open_directory(_path: &PathBuf) -> Result<(), String> {
    Err("Opening the log directory is not supported on this platform".to_string())
}

#[tauri::command]
pub async fn open_log_directory(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_, directory, _) = resolved_settings(&app)?;
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        open_directory(&directory)
    })
    .await
    .map_err(|error| error.to_string())?
}
