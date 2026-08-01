use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

const PACKAGE_FORMAT: &str = "nova-display-extension";
const PROTOCOL: &str = "nova-jsonl-v1";
const MAX_EXTRACTED_BYTES: u64 = 128 * 1024 * 1024;
const MAX_FILES: usize = 512;
const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
const MAX_LOG_LINES: usize = 200;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderManifest {
    format: String,
    api_version: u32,
    id: String,
    runtime: String,
    entry: HashMap<String, String>,
    protocol: String,
    permissions: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderFile {
    path: String,
    bytes: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInstallResult {
    id: String,
    entry: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    id: String,
    running: bool,
    pid: Option<u32>,
    last_error: String,
}

struct ProviderProcess {
    child: Child,
    stdin: ChildStdin,
    messages: mpsc::Receiver<Value>,
    logs: Arc<Mutex<VecDeque<String>>>,
    next_request_id: u64,
    fresh: bool,
}

pub struct ProviderState {
    processes: Mutex<HashMap<String, ProviderProcess>>,
    errors: Mutex<HashMap<String, String>>,
    archived_logs: Mutex<HashMap<String, VecDeque<String>>>,
}

impl ProviderState {
    pub fn new() -> Self {
        Self {
            processes: Mutex::new(HashMap::new()),
            errors: Mutex::new(HashMap::new()),
            archived_logs: Mutex::new(HashMap::new()),
        }
    }
}

impl Drop for ProviderState {
    fn drop(&mut self) {
        if let Ok(processes) = self.processes.get_mut() {
            for process in processes.values_mut() {
                stop_process(process);
            }
            processes.clear();
        }
    }
}

fn validate_id(id: &str) -> Result<(), String> {
    let valid = !id.is_empty()
        && id.len() <= 80
        && id.contains('.')
        && id.bytes().all(|value| {
            value.is_ascii_lowercase() || value.is_ascii_digit() || value == b'.' || value == b'-'
        });
    if valid {
        Ok(())
    } else {
        Err("Provider 扩展 ID 无效".into())
    }
}

fn validate_relative_path(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if value.is_empty() || path.is_absolute() {
        return Err("Provider 入口路径无效".into());
    }
    if path
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("Provider 路径必须位于扩展包内部".into());
    }
    Ok(path.to_path_buf())
}

fn provider_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("providers"))
        .map_err(|error| error.to_string())
}

fn provider_directory(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    validate_id(id)?;
    Ok(provider_root(app)?.join(id))
}

fn platform_entry(manifest: &ProviderManifest) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    let platform = "windows";
    #[cfg(target_os = "linux")]
    let platform = "linux";
    #[cfg(target_os = "macos")]
    let platform = "macos";
    manifest
        .entry
        .get(platform)
        .cloned()
        .ok_or_else(|| format!("此扩展不支持当前平台：{platform}"))
}

fn validate_manifest(manifest: &ProviderManifest) -> Result<String, String> {
    if manifest.format != PACKAGE_FORMAT
        || manifest.api_version != 2
        || manifest.runtime != "provider"
    {
        return Err("这不是受支持的 Provider 扩展包".into());
    }
    validate_id(&manifest.id)?;
    if manifest.protocol != PROTOCOL {
        return Err(format!("暂不支持 Provider 协议 {}", manifest.protocol));
    }
    if manifest.permissions.as_slice() != ["native.process"] {
        return Err("Provider 扩展必须且只能声明 native.process 权限".into());
    }
    let entry = platform_entry(manifest)?;
    validate_relative_path(&entry)?;
    Ok(entry)
}

fn stop_process(process: &mut ProviderProcess) {
    let _ = writeln!(process.stdin, "{}", json!({ "type": "shutdown" }));
    let _ = process.stdin.flush();
    thread::sleep(Duration::from_millis(30));
    match process.child.try_wait() {
        Ok(Some(_)) => {}
        _ => {
            let _ = process.child.kill();
            let _ = process.child.wait();
        }
    }
}

fn stop_locked(
    processes: &mut HashMap<String, ProviderProcess>,
    id: &str,
) -> Option<VecDeque<String>> {
    if let Some(mut process) = processes.remove(id) {
        stop_process(&mut process);
        return process.logs.lock().ok().map(|logs| logs.clone());
    }
    None
}

fn archive_logs(state: &ProviderState, id: &str, logs: Option<VecDeque<String>>) {
    if let (Some(logs), Ok(mut archived)) = (logs, state.archived_logs.lock()) {
        archived.insert(id.to_string(), logs);
    }
}

#[tauri::command]
pub fn install_provider_extension(
    app: AppHandle,
    state: State<'_, ProviderState>,
    manifest: Value,
    files: Vec<ProviderFile>,
) -> Result<ProviderInstallResult, String> {
    if files.is_empty() || files.len() > MAX_FILES {
        return Err(format!("扩展包文件数量不能超过 {MAX_FILES}"));
    }
    let manifest: ProviderManifest =
        serde_json::from_value(manifest).map_err(|error| format!("扩展清单无法解析：{error}"))?;
    let entry = validate_manifest(&manifest)?;
    let root = provider_root(&app)?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let staging = root.join(format!(".install-{}-{nonce}", manifest.id));
    fs::create_dir(&staging).map_err(|error| error.to_string())?;

    let extraction = (|| -> Result<(), String> {
        let mut total = 0_u64;
        for source in files {
            total = total.saturating_add(source.bytes.len() as u64);
            if total > MAX_EXTRACTED_BYTES {
                return Err("扩展解压后不能超过 128 MB".into());
            }
            let relative = validate_relative_path(&source.path)?;
            let destination = staging.join(relative);
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            let mut output = File::create(destination).map_err(|error| error.to_string())?;
            output
                .write_all(&source.bytes)
                .map_err(|error| error.to_string())?;
        }
        let executable = staging.join(validate_relative_path(&entry)?);
        if !executable.is_file() {
            return Err("扩展包中缺少当前平台的 Provider 入口文件".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fs::metadata(&executable)
                .map_err(|error| error.to_string())?
                .permissions();
            permissions.set_mode(0o700);
            fs::set_permissions(&executable, permissions).map_err(|error| error.to_string())?;
        }
        Ok(())
    })();

    if let Err(error) = extraction {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }

    let destination = provider_directory(&app, &manifest.id)?;
    {
        let mut processes = state
            .processes
            .lock()
            .map_err(|_| "Provider 状态锁已损坏".to_string())?;
        let logs = stop_locked(&mut processes, &manifest.id);
        archive_logs(&state, &manifest.id, logs);
    }
    let backup = root.join(format!(".backup-{}-{nonce}", manifest.id));
    if destination.exists() {
        fs::rename(&destination, &backup)
            .map_err(|error| format!("无法暂存旧版 Provider：{error}"))?;
    }
    if let Err(error) = fs::rename(&staging, &destination) {
        if backup.exists() {
            let _ = fs::rename(&backup, &destination);
        }
        return Err(format!("无法完成 Provider 安装：{error}"));
    }
    if backup.exists() {
        let _ = fs::remove_dir_all(backup);
    }
    state
        .errors
        .lock()
        .map_err(|_| "Provider 状态锁已损坏".to_string())?
        .remove(&manifest.id);
    Ok(ProviderInstallResult {
        id: manifest.id,
        entry,
    })
}

fn read_installed_manifest(directory: &Path) -> Result<(ProviderManifest, String), String> {
    let text = fs::read_to_string(directory.join("manifest.json"))
        .map_err(|_| "Provider 安装内容不完整".to_string())?;
    let manifest: ProviderManifest =
        serde_json::from_str(&text).map_err(|error| format!("Provider 清单损坏：{error}"))?;
    let entry = validate_manifest(&manifest)?;
    Ok((manifest, entry))
}

fn push_log(logs: &Arc<Mutex<VecDeque<String>>>, line: String) {
    if let Ok(mut entries) = logs.lock() {
        if entries.len() >= MAX_LOG_LINES {
            entries.pop_front();
        }
        entries.push_back(line.chars().take(1000).collect());
    }
}

fn spawn_provider(app: &AppHandle, id: &str) -> Result<ProviderProcess, String> {
    let directory = provider_directory(app, id)?;
    spawn_provider_from_directory(&directory, id)
}

fn spawn_provider_from_directory(directory: &Path, id: &str) -> Result<ProviderProcess, String> {
    let (manifest, entry) = read_installed_manifest(&directory)?;
    if manifest.id != id {
        return Err("Provider 安装目录与清单 ID 不一致".into());
    }
    let executable = directory.join(validate_relative_path(&entry)?);
    let mut command = Command::new(&executable);
    command
        .current_dir(&directory)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 Provider：{error}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "无法连接 Provider 输入".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法连接 Provider 输出".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法连接 Provider 日志".to_string())?;
    let (sender, messages) = mpsc::sync_channel(128);
    let logs = Arc::new(Mutex::new(VecDeque::new()));
    let stdout_logs = Arc::clone(&logs);
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if line.len() > MAX_MESSAGE_BYTES {
                push_log(&stdout_logs, "[host] 已丢弃超过 1 MB 的协议消息".into());
                continue;
            }
            match serde_json::from_str::<Value>(&line) {
                Ok(message) => {
                    if sender.try_send(message).is_err() {
                        push_log(
                            &stdout_logs,
                            "[host] Provider 输出过快，部分消息已丢弃".into(),
                        );
                    }
                }
                Err(error) => push_log(&stdout_logs, format!("[stdout] 非法 JSON：{error}")),
            }
        }
    });
    let stderr_logs = Arc::clone(&logs);
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            match line {
                Ok(line) => push_log(&stderr_logs, format!("[stderr] {line}")),
                Err(_) => break,
            }
        }
    });
    Ok(ProviderProcess {
        child,
        stdin,
        messages,
        logs,
        next_request_id: 0,
        fresh: true,
    })
}

fn write_message(stdin: &mut ChildStdin, message: &Value) -> Result<(), String> {
    let encoded = serde_json::to_string(message).map_err(|error| error.to_string())?;
    if encoded.len() > MAX_MESSAGE_BYTES {
        return Err("发送给 Provider 的消息超过 1 MB".into());
    }
    writeln!(stdin, "{encoded}")
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("Provider 通信失败：{error}"))
}

fn record_error(state: &ProviderState, id: &str, error: &str) {
    if let Ok(mut errors) = state.errors.lock() {
        errors.insert(id.to_string(), error.to_string());
    }
}

#[tauri::command]
pub fn tick_provider_extension(
    app: AppHandle,
    state: State<'_, ProviderState>,
    id: String,
    input: Value,
    render_requests: Value,
) -> Result<Value, String> {
    validate_id(&id)?;
    let mut processes = state
        .processes
        .lock()
        .map_err(|_| "Provider 状态锁已损坏".to_string())?;
    if !processes.contains_key(&id) {
        let mut process =
            spawn_provider(&app, &id).inspect_err(|error| record_error(&state, &id, error))?;
        write_message(
            &mut process.stdin,
            &json!({
                "type": "initialize",
                "protocol": PROTOCOL,
                "extensionId": id,
                "host": { "name": "Nova Display", "version": env!("CARGO_PKG_VERSION"), "platform": std::env::consts::OS }
            }),
        )?;
        processes.insert(id.clone(), process);
    }
    let process = processes.get_mut(&id).expect("provider inserted");
    if let Ok(Some(status)) = process.child.try_wait() {
        let error = format!("Provider 已退出：{status}");
        record_error(&state, &id, &error);
        let logs = stop_locked(&mut processes, &id);
        archive_logs(&state, &id, logs);
        return Err(error);
    }
    process.next_request_id += 1;
    let request_id = process.next_request_id;
    let timeout = if process.fresh {
        Duration::from_millis(1500)
    } else {
        Duration::from_millis(350)
    };
    process.fresh = false;
    if let Err(error) = write_message(
        &mut process.stdin,
        &json!({
            "type": "tick",
            "requestId": request_id,
            "context": input,
            "renders": render_requests,
        }),
    ) {
        record_error(&state, &id, &error);
        let logs = stop_locked(&mut processes, &id);
        archive_logs(&state, &id, logs);
        return Err(error);
    }

    let mut variables = serde_json::Map::new();
    let mut renders: Vec<Value> = Vec::new();
    let mut events: Vec<Value> = Vec::new();
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            let error = format!(
                "Provider 响应超时（{} ms），进程已终止",
                timeout.as_millis()
            );
            record_error(&state, &id, &error);
            let logs = stop_locked(&mut processes, &id);
            archive_logs(&state, &id, logs);
            return Err(error);
        }
        let message = match process.messages.recv_timeout(remaining) {
            Ok(message) => message,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(_) => {
                let error = "Provider 通信已断开".to_string();
                record_error(&state, &id, &error);
                let logs = stop_locked(&mut processes, &id);
                archive_logs(&state, &id, logs);
                return Err(error);
            }
        };
        match message.get("type").and_then(Value::as_str) {
            Some("variables") => {
                if let Some(values) = message.get("values").and_then(Value::as_object) {
                    variables.extend(values.clone());
                }
            }
            Some("frame") => renders.push(json!({
                "id": message.get("layerId").and_then(Value::as_str).unwrap_or_default(),
                "pixels": message.get("pixels").cloned().unwrap_or_else(|| json!([])),
            })),
            Some("event") => events.push(json!({
                "name": message.get("name").and_then(Value::as_str).unwrap_or_default(),
                "data": message.get("data").cloned().unwrap_or(Value::Null),
            })),
            Some("result")
                if message.get("requestId").and_then(Value::as_u64) == Some(request_id) =>
            {
                if let Some(values) = message.get("variables").and_then(Value::as_object) {
                    variables.extend(values.clone());
                }
                if let Some(values) = message.get("renders").and_then(Value::as_array) {
                    renders.extend(values.iter().cloned());
                }
                if let Some(values) = message.get("events").and_then(Value::as_array) {
                    events.extend(values.iter().cloned());
                }
                state
                    .errors
                    .lock()
                    .map_err(|_| "Provider 状态锁已损坏".to_string())?
                    .remove(&id);
                return Ok(json!({ "variables": variables, "renders": renders, "events": events }));
            }
            Some("error") => {
                let error = message
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Provider 报告未知错误")
                    .to_string();
                record_error(&state, &id, &error);
                return Err(error);
            }
            _ => {}
        }
    }
}

#[tauri::command]
pub fn stop_provider_extension(state: State<'_, ProviderState>, id: String) -> Result<(), String> {
    validate_id(&id)?;
    let mut processes = state
        .processes
        .lock()
        .map_err(|_| "Provider 状态锁已损坏".to_string())?;
    let logs = stop_locked(&mut processes, &id);
    archive_logs(&state, &id, logs);
    Ok(())
}

#[tauri::command]
pub fn remove_provider_extension(
    app: AppHandle,
    state: State<'_, ProviderState>,
    id: String,
) -> Result<(), String> {
    stop_provider_extension(state.clone(), id.clone())?;
    let directory = provider_directory(&app, &id)?;
    if directory.exists() {
        fs::remove_dir_all(directory)
            .map_err(|error| format!("无法删除 Provider 文件：{error}"))?;
    }
    state
        .errors
        .lock()
        .map_err(|_| "Provider 状态锁已损坏".to_string())?
        .remove(&id);
    state
        .archived_logs
        .lock()
        .map_err(|_| "Provider 日志锁已损坏".to_string())?
        .remove(&id);
    Ok(())
}

#[tauri::command]
pub fn get_provider_statuses(
    state: State<'_, ProviderState>,
) -> Result<Vec<ProviderStatus>, String> {
    let mut processes = state
        .processes
        .lock()
        .map_err(|_| "Provider 状态锁已损坏".to_string())?;
    let ids: Vec<String> = processes.keys().cloned().collect();
    let errors = state
        .errors
        .lock()
        .map_err(|_| "Provider 状态锁已损坏".to_string())?;
    let mut result = Vec::new();
    for id in ids {
        if let Some(process) = processes.get_mut(&id) {
            let running = matches!(process.child.try_wait(), Ok(None));
            result.push(ProviderStatus {
                id: id.clone(),
                running,
                pid: running.then(|| process.child.id()),
                last_error: errors.get(&id).cloned().unwrap_or_default(),
            });
        }
    }
    for (id, error) in errors.iter() {
        if !result.iter().any(|status| status.id == *id) {
            result.push(ProviderStatus {
                id: id.clone(),
                running: false,
                pid: None,
                last_error: error.clone(),
            });
        }
    }
    Ok(result)
}

#[tauri::command]
pub fn get_provider_logs(
    state: State<'_, ProviderState>,
    id: String,
) -> Result<Vec<String>, String> {
    validate_id(&id)?;
    let processes = state
        .processes
        .lock()
        .map_err(|_| "Provider 状态锁已损坏".to_string())?;
    if let Some(process) = processes.get(&id) {
        let logs = process
            .logs
            .lock()
            .map_err(|_| "Provider 日志锁已损坏".to_string())?;
        return Ok(logs.iter().cloned().collect());
    }
    drop(processes);
    let archived = state
        .archived_logs
        .lock()
        .map_err(|_| "Provider 日志锁已损坏".to_string())?;
    Ok(archived
        .get(&id)
        .map(|logs| logs.iter().cloned().collect())
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_ids_are_strictly_scoped() {
        assert!(validate_id("com.example.audio").is_ok());
        assert!(validate_id("../escape").is_err());
        assert!(validate_id("Com.Example.Audio").is_err());
    }

    #[test]
    fn provider_entries_cannot_escape_package() {
        assert!(validate_relative_path("bin/provider.exe").is_ok());
        assert!(validate_relative_path("../provider.exe").is_err());
        assert!(validate_relative_path("C:\\provider.exe").is_err());
    }

    #[test]
    fn development_provider_exchanges_json_lines() {
        let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("workspace root")
            .join("extensions/examples/provider-counter");
        let mut process = spawn_provider_from_directory(&directory, "dev.nova.provider-counter")
            .expect("start provider");
        write_message(&mut process.stdin, &json!({
            "type": "tick",
            "requestId": 7,
            "context": { "timeMs": 1000 },
            "renders": [{ "id": "layer-a", "width": 8, "height": 4, "settings": { "columns": 4 } }]
        })).expect("send tick");
        let result = process
            .messages
            .recv_timeout(Duration::from_secs(2))
            .expect("provider response");
        assert_eq!(result.get("type").and_then(Value::as_str), Some("result"));
        assert_eq!(result.get("requestId").and_then(Value::as_u64), Some(7));
        stop_process(&mut process);
    }
}
