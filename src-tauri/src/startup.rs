use serde::Serialize;
use std::path::{Path, PathBuf};

const APP_NAME: &str = "Nova Display Controller";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupStatus {
    pub supported: bool,
    pub enabled: bool,
    pub target: String,
}

fn current_exe_path() -> Result<PathBuf, String> {
    std::env::current_exe()
        .map(|path| dunce_path(path.as_path()))
        .map_err(|error| error.to_string())
}

fn dunce_path(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(stripped) = text.strip_prefix(r"\\?\") {
        PathBuf::from(stripped)
    } else {
        path.to_path_buf()
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{current_exe_path, StartupStatus, APP_NAME};
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    const STARTUP_APPROVED_KEY: &str =
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
    const VALUE_NAME: &str = "NovaDisplayController";
    const LEGACY_VALUE_NAME: &str = "SteelSeriesOLEDController";

    fn reg_command() -> Command {
        let mut command = Command::new("reg");
        command.creation_flags(CREATE_NO_WINDOW);
        command
    }

    fn query_value(name: &str) -> Result<Option<String>, String> {
        let output = reg_command()
            .args(["query", RUN_KEY, "/v", name])
            .output()
            .map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Ok(None);
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let value = text
            .lines()
            .find(|line| line.contains(name))
            .and_then(|line| line.split("REG_SZ").nth(1))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);
        Ok(value)
    }

    fn delete_value(name: &str) -> Result<(), String> {
        let status = reg_command()
            .args(["delete", RUN_KEY, "/v", name, "/f"])
            .status()
            .map_err(|error| error.to_string())?;
        if !status.success() && query_value(name)?.is_some() {
            return Err(format!("无法删除 {APP_NAME} 开机自启动项"));
        }
        Ok(())
    }

    fn query_approval(name: &str) -> Result<Option<bool>, String> {
        let output = reg_command()
            .args(["query", STARTUP_APPROVED_KEY, "/v", name])
            .output()
            .map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Ok(None);
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let data = text
            .lines()
            .find(|line| line.contains(name))
            .and_then(|line| line.split("REG_BINARY").nth(1))
            .map(|value| {
                value
                    .chars()
                    .filter(|character| !character.is_whitespace())
                    .collect::<String>()
            })
            .filter(|value| value.len() >= 2);
        let Some(data) = data else {
            return Ok(None);
        };
        let state = u8::from_str_radix(&data[..2], 16).map_err(|error| error.to_string())?;
        Ok(Some(state % 2 == 0))
    }

    fn delete_approval(name: &str) -> Result<(), String> {
        let status = reg_command()
            .args(["delete", STARTUP_APPROVED_KEY, "/v", name, "/f"])
            .status()
            .map_err(|error| error.to_string())?;
        if !status.success() && query_approval(name)?.is_some() {
            return Err(format!("无法更新 {APP_NAME} 的 Windows 启动状态"));
        }
        Ok(())
    }

    fn write_disabled_approval(name: &str) -> Result<(), String> {
        let status = reg_command()
            .args([
                "add",
                STARTUP_APPROVED_KEY,
                "/v",
                name,
                "/t",
                "REG_BINARY",
                "/d",
                "030000000000000000000000",
                "/f",
            ])
            .status()
            .map_err(|error| error.to_string())?;
        if !status.success() {
            return Err(format!("无法同步 {APP_NAME} 的 Windows 启动状态"));
        }
        Ok(())
    }

    fn target() -> Result<String, String> {
        Ok(format!("\"{}\" --hidden", current_exe_path()?.display()))
    }

    fn write_value(target: &str) -> Result<(), String> {
        let status = reg_command()
            .args([
                "add", RUN_KEY, "/v", VALUE_NAME, "/t", "REG_SZ", "/d", target, "/f",
            ])
            .status()
            .map_err(|error| error.to_string())?;
        if !status.success() {
            return Err(format!("无法写入 {APP_NAME} 开机自启动项"));
        }
        Ok(())
    }

    pub fn status() -> Result<StartupStatus, String> {
        let target = target()?;
        let current = query_value(VALUE_NAME)?;
        let legacy = query_value(LEGACY_VALUE_NAME)?;
        let configured = current.is_some() || legacy.is_some();
        let approval = if current.is_some() {
            query_approval(VALUE_NAME)?
        } else if legacy.is_some() {
            query_approval(LEGACY_VALUE_NAME)?
        } else {
            None
        };
        let enabled = configured && approval.unwrap_or(true);
        if configured && !cfg!(debug_assertions) && current.as_deref() != Some(target.as_str()) {
            write_value(&target)?;
            if current.is_none() && approval == Some(false) {
                write_disabled_approval(VALUE_NAME)?;
            }
        }
        if legacy.is_some() && !cfg!(debug_assertions) {
            delete_value(LEGACY_VALUE_NAME)?;
            delete_approval(LEGACY_VALUE_NAME)?;
        }
        Ok(StartupStatus {
            supported: true,
            enabled,
            target,
        })
    }

    pub fn set_enabled(enabled: bool) -> Result<StartupStatus, String> {
        if enabled {
            let target = target()?;
            write_value(&target)?;
            delete_approval(VALUE_NAME)?;
            delete_value(LEGACY_VALUE_NAME)?;
            delete_approval(LEGACY_VALUE_NAME)?;
        } else {
            delete_value(VALUE_NAME)?;
            delete_value(LEGACY_VALUE_NAME)?;
            delete_approval(VALUE_NAME)?;
            delete_approval(LEGACY_VALUE_NAME)?;
        }
        status()
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::{current_exe_path, StartupStatus, APP_NAME};
    use std::fs;
    use std::path::PathBuf;

    const DESKTOP_FILE: &str = "nova-display-controller.desktop";
    const LEGACY_DESKTOP_FILE: &str = "steelseries-oled-controller.desktop";

    fn autostart_path(name: &str) -> Result<PathBuf, String> {
        let home = std::env::var("HOME").map_err(|_| "无法读取 HOME 环境变量".to_string())?;
        Ok(PathBuf::from(home)
            .join(".config")
            .join("autostart")
            .join(name))
    }

    fn target() -> Result<String, String> {
        Ok(current_exe_path()?.display().to_string())
    }

    fn write_desktop(path: &PathBuf) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let exec = target()?.replace('\\', r"\\").replace('"', "\\\"");
        let content = format!(
            "[Desktop Entry]\nType=Application\nName={APP_NAME}\nExec=\"{exec}\" --hidden\nTerminal=false\nX-GNOME-Autostart-enabled=true\n"
        );
        fs::write(path, content).map_err(|error| error.to_string())
    }

    pub fn status() -> Result<StartupStatus, String> {
        let target = target()?;
        let path = autostart_path(DESKTOP_FILE)?;
        let legacy_path = autostart_path(LEGACY_DESKTOP_FILE)?;
        let enabled = path.exists() || legacy_path.exists();
        let needs_upgrade = enabled
            && fs::read_to_string(&path)
                .map(|content| !content.contains(" --hidden"))
                .unwrap_or(true);
        if needs_upgrade && !cfg!(debug_assertions) {
            write_desktop(&path)?;
        }
        if legacy_path.exists() && !cfg!(debug_assertions) {
            fs::remove_file(&legacy_path).map_err(|error| error.to_string())?;
        }
        Ok(StartupStatus {
            supported: true,
            enabled,
            target,
        })
    }

    pub fn set_enabled(enabled: bool) -> Result<StartupStatus, String> {
        let path = autostart_path(DESKTOP_FILE)?;
        let legacy_path = autostart_path(LEGACY_DESKTOP_FILE)?;
        if enabled {
            write_desktop(&path)?;
            if legacy_path.exists() {
                fs::remove_file(&legacy_path).map_err(|error| error.to_string())?;
            }
        } else if path.exists() {
            fs::remove_file(&path).map_err(|error| error.to_string())?;
        }
        if !enabled && legacy_path.exists() {
            fs::remove_file(&legacy_path).map_err(|error| error.to_string())?;
        }
        status()
    }
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
mod platform {
    use super::StartupStatus;

    pub fn status() -> Result<StartupStatus, String> {
        Ok(StartupStatus {
            supported: false,
            enabled: false,
            target: String::new(),
        })
    }

    pub fn set_enabled(_enabled: bool) -> Result<StartupStatus, String> {
        status()
    }
}

#[tauri::command]
pub fn get_startup_status() -> Result<StartupStatus, String> {
    platform::status()
}

#[tauri::command]
pub fn set_launch_on_startup(enabled: bool) -> Result<StartupStatus, String> {
    platform::set_enabled(enabled)
}
