use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::time::Duration;

const GAME_ID: &str = "NOVA_DISPLAY_CONTROLLER";
const EVENT_ID: &str = "OLED_128X64_PROBE";

#[derive(Deserialize)]
struct CoreProps {
    address: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GameSenseStatus {
    pub installed: bool,
    pub running: bool,
    pub address: String,
    pub source: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameSenseTestResult {
    pub accepted: bool,
    pub message: String,
}

fn core_props_paths() -> Vec<PathBuf> {
    let Some(program_data) = std::env::var_os("PROGRAMDATA") else {
        return Vec::new();
    };
    let root = PathBuf::from(program_data).join("SteelSeries");
    vec![
        root.join("GG").join("coreProps.json"),
        root.join("SteelSeries Engine 3").join("coreProps.json"),
    ]
}

fn local_address(value: &str) -> Result<SocketAddr, String> {
    let address = value
        .parse::<SocketAddr>()
        .map_err(|_| format!("GameSense 地址格式无效：{value}"))?;
    if !address.ip().is_loopback() {
        return Err("拒绝连接非本机 GameSense 地址".to_string());
    }
    Ok(address)
}

fn discover() -> Result<GameSenseStatus, String> {
    for path in core_props_paths() {
        if !path.is_file() {
            continue;
        }
        let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
        let props: CoreProps = serde_json::from_str(&content).map_err(|error| error.to_string())?;
        let address = props.address.unwrap_or_default();
        let running = local_address(&address)
            .and_then(|socket| {
                TcpStream::connect_timeout(&socket, Duration::from_millis(600))
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            })
            .is_ok();
        return Ok(GameSenseStatus {
            installed: true,
            running,
            address,
            source: path.display().to_string(),
        });
    }
    Ok(GameSenseStatus {
        installed: false,
        running: false,
        address: String::new(),
        source: String::new(),
    })
}

fn post_json(address: &str, path: &str, payload: &Value) -> Result<(), String> {
    let socket = local_address(address)?;
    let body = serde_json::to_vec(payload).map_err(|error| error.to_string())?;
    let mut stream = TcpStream::connect_timeout(&socket, Duration::from_secs(2))
        .map_err(|error| format!("无法连接 GameSense：{error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .map_err(|error| error.to_string())?;
    let header = format!(
        "POST {path} HTTP/1.1\r\nHost: {address}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream
        .write_all(header.as_bytes())
        .and_then(|_| stream.write_all(&body))
        .map_err(|error| error.to_string())?;

    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .map_err(|error| error.to_string())?;
    let text = String::from_utf8_lossy(&response);
    let status = text
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or("GameSense 返回了无效 HTTP 响应")?;
    if (200..300).contains(&status) {
        return Ok(());
    }
    let detail = text.split("\r\n\r\n").nth(1).unwrap_or("").trim();
    Err(if detail.is_empty() {
        format!("GameSense 请求失败：HTTP {status}")
    } else {
        format!("GameSense 请求失败：HTTP {status} - {detail}")
    })
}

fn diagnostic_frame() -> Vec<u8> {
    let mut frame = vec![0u8; 128 * 64 / 8];
    for y in 0..64usize {
        for x in 0..128usize {
            let border = x == 0 || x == 127 || y == 0 || y == 63;
            let diagonal = x == y * 2 || x + y * 2 == 127;
            let center = (x == 63 || x == 64) && (16..48).contains(&y);
            if border || diagonal || center {
                frame[y * 16 + x / 8] |= 1 << (7 - x % 8);
            }
        }
    }
    frame
}

#[tauri::command]
pub fn get_gamesense_status() -> Result<GameSenseStatus, String> {
    discover()
}

#[tauri::command]
pub fn send_gamesense_probe() -> Result<GameSenseTestResult, String> {
    let status = discover()?;
    if !status.running {
        return Err("SteelSeries GG GameSense 服务未运行".to_string());
    }
    post_json(
        &status.address,
        "/game_metadata",
        &json!({
            "game": GAME_ID,
            "game_display_name": "Nova Display Controller",
            "developer": "Nova Display Controller",
            "deinitialize_timer_length_ms": 15000
        }),
    )?;
    post_json(
        &status.address,
        "/bind_game_event",
        &json!({
            "game": GAME_ID,
            "event": EVENT_ID,
            "min_value": 0,
            "max_value": 100,
            "icon_id": 0,
            "value_optional": true,
            "handlers": [{
                "device-type": "screened-128x64",
                "zone": "one",
                "mode": "screen",
                "datas": [{
                    "has-text": false,
                    "image-data": diagnostic_frame()
                }]
            }]
        }),
    )?;
    post_json(
        &status.address,
        "/game_event",
        &json!({
            "game": GAME_ID,
            "event": EVENT_ID,
            "data": { "value": 1 }
        }),
    )?;
    Ok(GameSenseTestResult {
        accepted: true,
        message: "GG 已接受 128 x 64 事件；请观察基座是否出现带 X 的边框测试图".to_string(),
    })
}

#[tauri::command]
pub fn remove_gamesense_probe() -> Result<(), String> {
    let status = discover()?;
    if !status.running {
        return Err("SteelSeries GG GameSense 服务未运行".to_string());
    }
    post_json(&status.address, "/remove_game", &json!({ "game": GAME_ID }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostic_frame_is_row_major_one_bit() {
        let frame = diagnostic_frame();
        assert_eq!(frame.len(), 1024);
        assert_eq!(frame[0], 0xff);
        assert_eq!(frame[16], 0xa0);
    }
}
