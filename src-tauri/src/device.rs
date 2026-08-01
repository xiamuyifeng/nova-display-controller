use hidapi::{HidApi, HidDevice, MAX_REPORT_DESCRIPTOR_SIZE};
use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use sysinfo::{CpuRefreshKind, MemoryRefreshKind, RefreshKind, System};
use tauri::{AppHandle, State};

use crate::diagnostics;

use crate::MetricsState;

const VENDOR_ID: u16 = 0x1038;
const REPORT_ID: u8 = 0x06;
const CMD_RETURN_UI: u8 = 0x95;
const MAX_PENDING_REPORTS_PER_INTERFACE: usize = 256;

#[derive(Clone, Copy)]
struct BaseModel {
    product_id: u16,
    name: &'static str,
    width: u16,
    height: u16,
    interface_number: Option<i32>,
    oled_report_id: Option<u8>,
    info_report_id: Option<u8>,
    protocol: &'static str,
    support: &'static str,
    supported: bool,
}

const BASE_MODELS: &[BaseModel] = &[
    BaseModel {
        product_id: 0x12CB,
        name: "Arctis Nova Pro Wired",
        width: 128,
        height: 64,
        interface_number: Some(4),
        oled_report_id: Some(0x06),
        info_report_id: Some(0x06),
        protocol: "Nova Pro HID",
        support: "supported",
        supported: true,
    },
    BaseModel {
        product_id: 0x12CD,
        name: "Arctis Nova Pro Wired Xbox",
        width: 128,
        height: 64,
        interface_number: Some(4),
        oled_report_id: Some(0x06),
        info_report_id: Some(0x06),
        protocol: "Nova Pro HID",
        support: "supported",
        supported: true,
    },
    BaseModel {
        product_id: 0x12E0,
        name: "Arctis Nova Pro Wireless",
        width: 128,
        height: 64,
        interface_number: Some(4),
        oled_report_id: Some(0x06),
        info_report_id: Some(0x06),
        protocol: "Nova Pro HID",
        support: "supported",
        supported: true,
    },
    BaseModel {
        product_id: 0x12E5,
        name: "Arctis Nova Pro Wireless Xbox",
        width: 128,
        height: 64,
        interface_number: Some(4),
        oled_report_id: Some(0x06),
        info_report_id: Some(0x06),
        protocol: "Nova Pro HID",
        support: "supported",
        supported: true,
    },
    BaseModel {
        product_id: 0x225D,
        name: "Arctis Nova Pro Wireless Xbox White",
        width: 128,
        height: 64,
        interface_number: Some(4),
        oled_report_id: Some(0x06),
        info_report_id: Some(0x06),
        protocol: "Nova Pro HID",
        support: "supported",
        supported: true,
    },
    BaseModel {
        product_id: 0x2244,
        name: "Arctis Nova Elite",
        width: 128,
        height: 64,
        interface_number: Some(3),
        oled_report_id: Some(0x01),
        info_report_id: Some(0x07),
        protocol: "Nova Elite HID",
        support: "planned",
        supported: false,
    },
    BaseModel {
        product_id: 0x2290,
        name: "Arctis Nova Pro Omni",
        width: 128,
        height: 64,
        interface_number: Some(3),
        oled_report_id: Some(0x01),
        info_report_id: Some(0x07),
        protocol: "Nova Pro Omni HID",
        support: "experimental",
        supported: false,
    },
    BaseModel {
        product_id: 0x1290,
        name: "Arctis Pro Wireless Base Station",
        width: 128,
        height: 48,
        interface_number: Some(1),
        oled_report_id: Some(0x00),
        info_report_id: Some(0x00),
        protocol: "Legacy Arctis HID",
        support: "research",
        supported: false,
    },
    BaseModel {
        product_id: 0x1280,
        name: "GameDAC / Arctis Pro Wired",
        width: 128,
        height: 52,
        interface_number: None,
        oled_report_id: None,
        info_report_id: None,
        protocol: "GameSense 128x52",
        support: "gamesense",
        supported: false,
    },
];

const KNOWN_NON_BASE_PIDS: &[u16] = &[0x1294, 0x2249];

fn known_model(product_id: u16) -> Option<&'static BaseModel> {
    BASE_MODELS
        .iter()
        .find(|model| model.product_id == product_id)
}

fn selection_id(product_id: u16, serial_number: Option<&str>) -> String {
    match serial_number.filter(|serial| !serial.is_empty()) {
        Some(serial) => format!("{VENDOR_ID:04X}:{product_id:04X}:{serial}"),
        None => format!("{VENDOR_ID:04X}:{product_id:04X}"),
    }
}

pub struct DeviceConnection {
    pub oled: HidDevice,
    pub oled_report_id: u8,
    info: Option<HidDevice>,
    info_report_id: u8,
    device_id: String,
    product_id: u16,
    interface_number: i32,
    product: String,
    status: DeviceInfo,
    last_status_probe: Option<Instant>,
    #[cfg(debug_assertions)]
    status_event_logged: bool,
    #[cfg(debug_assertions)]
    status_packets_logged: usize,
}

pub struct DeviceState {
    pub device: Mutex<Option<DeviceConnection>>,
}

impl DeviceState {
    pub fn new() -> Self {
        Self {
            device: Mutex::new(None),
        }
    }

    pub fn return_to_base_ui(&self) -> Result<bool, String> {
        let guard = self
            .device
            .lock()
            .map_err(|_| "设备状态锁已损坏".to_string())?;
        let Some(connection) = guard.as_ref() else {
            return Ok(false);
        };
        send_return_ui(connection)?;
        Ok(true)
    }

    pub fn release_to_base_ui(&self) -> Result<bool, String> {
        let connection = self
            .device
            .lock()
            .map_err(|_| "设备状态锁已损坏".to_string())?
            .take();
        let Some(connection) = connection else {
            return Ok(false);
        };
        send_return_ui(&connection)?;
        Ok(true)
    }
}

impl Drop for DeviceState {
    fn drop(&mut self) {
        if let Ok(slot) = self.device.get_mut() {
            if let Some(connection) = slot.take() {
                let _ = send_return_ui(&connection);
            }
        }
    }
}

fn send_return_ui(connection: &DeviceConnection) -> Result<(), String> {
    let mut report = [0u8; 64];
    report[0] = connection.oled_report_id;
    report[1] = CMD_RETURN_UI;
    connection
        .oled
        .send_feature_report(&report)
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub connected: bool,
    pub device_id: String,
    pub product: String,
    pub product_id: u16,
    pub interface_number: i32,
    pub oled_report_id: u8,
    pub width: u16,
    pub height: u16,
    pub battery: u8,
    pub battery_available: bool,
    pub spare_battery: u8,
    pub spare_battery_available: bool,
    pub headset_connected: bool,
    pub volume: u8,
    pub game_volume: u8,
    pub chat_volume: u8,
    pub charging: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DetectedDevice {
    pub id: String,
    pub product: String,
    pub product_id: u16,
    pub product_id_hex: String,
    pub serial_number: String,
    pub supported: bool,
    pub support: String,
    pub protocol: String,
    pub interface_number: Option<i32>,
    pub oled_report_id: Option<u8>,
    pub width: u16,
    pub height: u16,
    pub connected: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemMetrics {
    pub cpu: f32,
    pub memory: f32,
    pub used_memory_gb: f32,
    pub total_memory_gb: f32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub title: String,
    pub artist: String,
    pub progress: f32,
    pub playing: bool,
}

fn initial_status(
    device: &DetectedDevice,
    interface_number: i32,
    oled_report_id: u8,
) -> DeviceInfo {
    DeviceInfo {
        connected: true,
        device_id: device.id.clone(),
        product: device.product.clone(),
        product_id: device.product_id,
        interface_number,
        oled_report_id,
        width: device.width,
        height: device.height,
        battery: 0,
        battery_available: false,
        spare_battery: 0,
        spare_battery_available: false,
        headset_connected: false,
        volume: 0,
        game_volume: 100,
        chat_volume: 100,
        charging: false,
    }
}

fn looks_like_base_station(product: &str) -> bool {
    let product = product.to_ascii_lowercase();
    product.contains("arctis")
        || product.contains("gamedac")
        || product.contains("base station")
        || product.contains("transmitter")
}

fn battery_percent(level: u8) -> u8 {
    ((u16::from(level.min(8)) * 100) / 8) as u8
}

fn read_pending_reports(
    device: &HidDevice,
    source: &'static str,
    responses: &mut Vec<(&'static str, [u8; 64])>,
) -> Result<(), String> {
    device
        .set_blocking_mode(false)
        .map_err(|error| error.to_string())?;
    for _ in 0..MAX_PENDING_REPORTS_PER_INTERFACE {
        let mut response = [0u8; 64];
        match device.read(&mut response) {
            Ok(0) => break,
            Ok(_) => responses.push((source, response)),
            Err(error) => {
                #[cfg(debug_assertions)]
                eprintln!("[device] status read failed on {source}: {error}");
                return Err(error.to_string());
            }
        }
    }
    Ok(())
}

fn discover_devices(api: &HidApi, connected_id: Option<&str>) -> Vec<DetectedDevice> {
    let mut devices = Vec::<DetectedDevice>::new();

    for info in api
        .device_list()
        .filter(|info| info.vendor_id() == VENDOR_ID)
    {
        let product_id = info.product_id();
        if KNOWN_NON_BASE_PIDS.contains(&product_id) {
            continue;
        }

        let model = known_model(product_id);
        let usb_product = info.product_string().unwrap_or("").trim();
        if model.is_none() && (info.usage_page() != 0xFFC0 || !looks_like_base_station(usb_product))
        {
            continue;
        }

        let serial_number = info.serial_number().unwrap_or("").trim();
        let id = selection_id(product_id, Some(serial_number));
        if devices.iter().any(|device| device.id == id) {
            continue;
        }

        let product = model
            .map(|model| model.name.to_string())
            .or_else(|| (!usb_product.is_empty()).then(|| usb_product.to_string()))
            .unwrap_or_else(|| format!("Unknown SteelSeries Base 0x{product_id:04X}"));
        devices.push(DetectedDevice {
            id: id.clone(),
            product,
            product_id,
            product_id_hex: format!("0x{product_id:04X}"),
            serial_number: serial_number.to_string(),
            supported: model.is_some_and(|model| model.supported),
            support: model.map_or("unknown", |model| model.support).to_string(),
            protocol: model.map_or("Unknown", |model| model.protocol).to_string(),
            interface_number: model.and_then(|model| model.interface_number),
            oled_report_id: model.and_then(|model| model.oled_report_id),
            width: model.map_or(0, |model| model.width),
            height: model.map_or(0, |model| model.height),
            connected: connected_id == Some(id.as_str()),
        });
    }

    devices.sort_by_key(|device| (!device.supported, device.product.clone(), device.id.clone()));
    devices
}

#[tauri::command]
pub fn list_devices(state: State<DeviceState>) -> Result<Vec<DetectedDevice>, String> {
    let connected_id = state
        .device
        .lock()
        .map_err(|_| "Device state lock is poisoned")?
        .as_ref()
        .map(|connection| connection.device_id.clone());
    let api = HidApi::new().map_err(|error| error.to_string())?;
    let devices = discover_devices(&api, connected_id.as_deref());
    #[cfg(debug_assertions)]
    {
        eprintln!("[device] detected {} base station(s)", devices.len());
        for device in &devices {
            eprintln!(
                "[device] candidate: {} {}, interface={:?}, supported={}, connected={}",
                device.product,
                device.product_id_hex,
                device.interface_number,
                device.supported,
                device.connected
            );
        }
    }
    Ok(devices)
}

#[tauri::command]
pub fn connect(
    state: State<DeviceState>,
    app: AppHandle,
    device_id: Option<String>,
) -> Result<DeviceInfo, String> {
    #[cfg(debug_assertions)]
    eprintln!("[device] scanning for supported HID collections");
    let api = HidApi::new().map_err(|error| error.to_string())?;
    let detected = discover_devices(&api, None);
    let requested_id = device_id
        .as_deref()
        .filter(|id| !id.is_empty() && *id != "auto");
    let selected = match requested_id {
        Some(id) => detected
            .iter()
            .find(|device| device.id == id)
            .ok_or_else(|| "所选基座当前未连接".to_string())?,
        None => detected
            .iter()
            .find(|device| device.supported)
            .ok_or_else(|| {
                if detected.is_empty() {
                    "未检测到 SteelSeries 耳机基座".to_string()
                } else {
                    format!("已识别 {}，但暂不支持其 OLED 通信协议", detected[0].product)
                }
            })?,
    };
    if !selected.supported {
        return Err(format!(
            "已识别 {}（{}），但尚未实现 {} 协议",
            selected.product, selected.product_id_hex, selected.protocol
        ));
    }
    let model =
        known_model(selected.product_id).ok_or_else(|| "所选基座没有可用的协议定义".to_string())?;
    let interface_number = model
        .interface_number
        .ok_or_else(|| "所选基座没有直接 HID 接口定义".to_string())?;
    let mut opened = Vec::new();

    for info in api.device_list().filter(|info| {
        info.vendor_id() == VENDOR_ID
            && info.product_id() == selected.product_id
            && info.interface_number() == interface_number
            && (selected.serial_number.is_empty()
                || info.serial_number() == Some(selected.serial_number.as_str()))
    }) {
        let product = selected.product.clone();
        let device = info.open_device(&api).map_err(|error| {
            #[cfg(debug_assertions)]
            eprintln!(
                "[device] failed to open {:04x}:{:04x}: {error}",
                info.vendor_id(),
                info.product_id()
            );
            error.to_string()
        })?;
        let mut descriptor = [0u8; MAX_REPORT_DESCRIPTOR_SIZE];
        let descriptor_len = device.get_report_descriptor(&mut descriptor).unwrap_or(0);
        let descriptor_type = (descriptor_len > 1).then_some(descriptor[1]);
        let report_id = descriptor
            .windows(2)
            .find(|pair| pair[0] == 0x85)
            .map(|pair| pair[1])
            .unwrap_or(model.oled_report_id.unwrap_or(REPORT_ID));
        #[cfg(debug_assertions)]
        eprintln!(
            "[device] collection type={:02x?}, report_id=0x{report_id:02x}",
            descriptor_type
        );
        opened.push((device, descriptor_type, report_id, product));
    }

    if opened.is_empty() {
        return Err(format!(
            "已检测到 {}，但无法打开 HID 接口 {}",
            selected.product, interface_number
        ));
    }

    let oled_index = opened
        .iter()
        .position(|(_, descriptor, _, _)| *descriptor == Some(0xC0))
        .unwrap_or(0);
    let (oled, _, oled_report_id, product) = opened.swap_remove(oled_index);
    let info_report_id = model.info_report_id.unwrap_or(oled_report_id);
    let info_connection = opened
        .into_iter()
        .find(|(_, descriptor, _, _)| *descriptor == Some(0x00))
        .map(|(device, _, _, _)| device);
    let info = info_connection;
    let status = initial_status(selected, interface_number, oled_report_id);
    let connection = DeviceConnection {
        oled,
        oled_report_id,
        info,
        info_report_id,
        device_id: selected.id.clone(),
        product_id: selected.product_id,
        interface_number,
        product,
        status: status.clone(),
        last_status_probe: None,
        #[cfg(debug_assertions)]
        status_event_logged: false,
        #[cfg(debug_assertions)]
        status_packets_logged: 0,
    };
    *state.device.lock().map_err(|_| "设备状态锁已损坏")? = Some(connection);
    #[cfg(debug_assertions)]
    eprintln!(
        "[device] connected: {}, oled_report_id=0x{:02x}, info_report_id=0x{:02x}",
        status.product, oled_report_id, info_report_id
    );
    diagnostics::write_entry(
        &app,
        "info",
        &format!(
            "Connected to {} (PID 0x{:04X}, interface {}, OLED report 0x{:02X})",
            status.product, status.product_id, interface_number, oled_report_id
        ),
    );
    Ok(status)
}

#[tauri::command]
pub fn disconnect(state: State<DeviceState>, app: AppHandle) -> Result<(), String> {
    let restored = state.release_to_base_ui()?;
    diagnostics::write_entry(
        &app,
        "info",
        if restored {
            "Device disconnected after restoring the official base-station UI"
        } else {
            "Device disconnect requested without an active connection"
        },
    );
    Ok(())
}

#[tauri::command]
pub fn get_status(state: State<DeviceState>) -> Result<DeviceInfo, String> {
    let mut guard = state.device.lock().map_err(|_| "设备状态锁已损坏")?;
    let connection = guard.as_mut().ok_or("设备未连接")?;

    let should_probe = connection.last_status_probe.map_or(true, |last_probe| {
        last_probe.elapsed() >= Duration::from_secs(30)
    });
    if should_probe {
        for command in [0xB0, 0xB7, 0x20] {
            let mut report = [0u8; 64];
            report[0] = connection.oled_report_id;
            report[1] = command;
            #[cfg(debug_assertions)]
            eprintln!(
                "[device] status probe sent on oled: report_id=0x{:02x}, command=0x{command:02x}",
                connection.oled_report_id
            );
            if let Err(_error) = connection.oled.write(&report) {
                #[cfg(debug_assertions)]
                eprintln!("[device] optional status probe 0x{command:02x} failed: {_error}");
            }
        }
        connection.last_status_probe = Some(Instant::now());
    }

    let mut responses = Vec::new();
    read_pending_reports(&connection.oled, "oled", &mut responses)?;
    if let Some(info) = connection.info.as_ref() {
        read_pending_reports(info, "info", &mut responses)?;
    }

    #[cfg(debug_assertions)]
    let response_count = responses.len();
    for (_source, response) in responses {
        #[cfg(debug_assertions)]
        if connection.status_packets_logged < 12 {
            eprintln!(
                "[device] status raw from {_source}: id=0x{:02x}, cmd=0x{:02x}, bytes={:02x?}",
                response[0],
                response[1],
                &response[..16]
            );
            connection.status_packets_logged += 1;
        }

        match (response[0], response[1]) {
            (id, 0xB0) if id == connection.oled_report_id || id == connection.info_report_id => {
                let headset_connected = response[15] == 8 || response[5] == 1;
                connection.status.headset_connected = headset_connected;
                connection.status.battery = battery_percent(response[6]);
                connection.status.battery_available = headset_connected;
                connection.status.spare_battery = battery_percent(response[7]);
                connection.status.spare_battery_available = true;
                connection.status.charging = false;
            }
            (id, 0x20) if id == connection.oled_report_id || id == connection.info_report_id => {
                let raw = 0x38u8.saturating_sub(response[3]);
                connection.status.volume = ((raw as u16 * 100) / 0x38) as u8;
            }
            (0x07, 0x25) => {
                let raw = 0x38u8.saturating_sub(response[2]);
                connection.status.volume = ((raw as u16 * 100) / 0x38) as u8;
            }
            (0x07, 0x45) => {
                connection.status.game_volume = response[2].min(100);
                connection.status.chat_volume = response[3].min(100);
            }
            (0x07, 0xB5) => {
                connection.status.headset_connected = response[4] == 8 || response[3] == 1;
            }
            (id, 0xB7) if id == connection.oled_report_id || id == connection.info_report_id => {
                let headset_connected = response[4] == 8 || response[2] > 0;
                connection.status.headset_connected = headset_connected;
                connection.status.battery = battery_percent(response[2]);
                connection.status.battery_available = headset_connected;
                connection.status.spare_battery = battery_percent(response[3]);
                connection.status.spare_battery_available = true;
                connection.status.charging = false;
            }
            (0x07, 0xB7) => {
                let headset_connected = response[4] == 8 || response[2] > 0;
                connection.status.headset_connected = headset_connected;
                connection.status.battery = battery_percent(response[2]);
                connection.status.battery_available = headset_connected;
                connection.status.spare_battery = battery_percent(response[3]);
                connection.status.spare_battery_available = true;
                connection.status.charging = false;
            }
            _ => {}
        }
    }

    connection.status.connected = true;
    connection.status.device_id = connection.device_id.clone();
    connection.status.product = connection.product.clone();
    connection.status.product_id = connection.product_id;
    connection.status.interface_number = connection.interface_number;
    connection.status.oled_report_id = connection.oled_report_id;
    #[cfg(debug_assertions)]
    if response_count > 0 && !connection.status_event_logged {
        let battery = if connection.status.battery_available {
            format!("{}%", connection.status.battery)
        } else {
            "unknown".to_string()
        };
        let spare_battery = if connection.status.spare_battery_available {
            format!("{}%", connection.status.spare_battery)
        } else {
            "unknown".to_string()
        };
        eprintln!(
            "[device] first status event: responses={}, headset_battery={}, spare_battery={}, headset={}, volume={}%, game={}, chat={}",
            response_count,
            battery,
            spare_battery,
            connection.status.headset_connected,
            connection.status.volume,
            connection.status.game_volume,
            connection.status.chat_volume
        );
        connection.status_event_logged = true;
    }
    Ok(connection.status.clone())
}

#[tauri::command]
pub fn set_brightness(state: State<DeviceState>, level: u8) -> Result<(), String> {
    let guard = state.device.lock().map_err(|_| "设备状态锁已损坏")?;
    let connection = guard.as_ref().ok_or("设备未连接")?;
    let mut report = [0u8; 64];
    report[0] = connection.oled_report_id;
    report[1] = 0x85;
    report[2] = level.clamp(1, 10);
    connection
        .oled
        .write(&report)
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_system_metrics(state: State<MetricsState>) -> Result<SystemMetrics, String> {
    let mut guard = state.0.lock().map_err(|_| "系统监控状态锁已损坏")?;
    let system = guard.get_or_insert_with(|| {
        let refreshes = RefreshKind::nothing()
            .with_cpu(CpuRefreshKind::nothing().with_cpu_usage())
            .with_memory(MemoryRefreshKind::nothing().with_ram());
        System::new_with_specifics(refreshes)
    });
    system.refresh_cpu_usage();
    system.refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram());
    let total = system.total_memory();
    let used = system.used_memory();
    Ok(SystemMetrics {
        cpu: system.global_cpu_usage(),
        memory: if total == 0 {
            0.0
        } else {
            used as f32 / total as f32 * 100.0
        },
        used_memory_gb: used as f32 / 1_073_741_824.0,
        total_memory_gb: total as f32 / 1_073_741_824.0,
    })
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub fn get_media_info() -> Result<MediaInfo, String> {
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSessionManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus,
    };

    let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
        .map_err(|error| error.to_string())?
        .get()
        .map_err(|error| error.to_string())?;
    let session = manager
        .GetCurrentSession()
        .map_err(|error| error.to_string())?;
    let properties = session
        .TryGetMediaPropertiesAsync()
        .map_err(|error| error.to_string())?
        .get()
        .map_err(|error| error.to_string())?;
    let timeline = session
        .GetTimelineProperties()
        .map_err(|error| error.to_string())?;
    let playback = session
        .GetPlaybackInfo()
        .map_err(|error| error.to_string())?;

    let start = timeline
        .StartTime()
        .map_err(|error| error.to_string())?
        .Duration;
    let end = timeline
        .EndTime()
        .map_err(|error| error.to_string())?
        .Duration;
    let position = timeline
        .Position()
        .map_err(|error| error.to_string())?
        .Duration;
    let progress = if end <= start {
        0.0
    } else {
        ((position - start) as f64 / (end - start) as f64 * 100.0).clamp(0.0, 100.0) as f32
    };

    Ok(MediaInfo {
        title: properties
            .Title()
            .map_err(|error| error.to_string())?
            .to_string(),
        artist: properties
            .Artist()
            .map_err(|error| error.to_string())?
            .to_string(),
        progress,
        playing: playback
            .PlaybackStatus()
            .map_err(|error| error.to_string())?
            == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing,
    })
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn get_media_info() -> Result<MediaInfo, String> {
    Err("当前平台暂不支持系统媒体会话".to_string())
}

#[cfg(test)]
mod model_tests {
    use super::*;

    #[test]
    fn identifies_verified_nova_pro_wireless() {
        let model = known_model(0x12E0).expect("known model");
        assert_eq!(model.name, "Arctis Nova Pro Wireless");
        assert_eq!(model.interface_number, Some(4));
        assert_eq!(model.oled_report_id, Some(0x06));
        assert_eq!(model.info_report_id, Some(0x06));
        assert!(model.supported);
    }

    #[test]
    fn nova_elite_keeps_distinct_oled_and_info_report_ids() {
        let model = known_model(0x2244).expect("known model");
        assert_eq!(model.oled_report_id, Some(0x01));
        assert_eq!(model.info_report_id, Some(0x07));
    }

    #[test]
    fn recognizes_future_models_without_enabling_their_protocols() {
        for product_id in [0x2244, 0x2290, 0x1290, 0x1280] {
            assert!(!known_model(product_id).expect("known model").supported);
        }
    }

    #[test]
    fn creates_stable_selection_ids() {
        assert_eq!(selection_id(0x12E0, None), "1038:12E0");
        assert_eq!(selection_id(0x12E0, Some("ABC123")), "1038:12E0:ABC123");
        assert_eq!(selection_id(0x12E0, Some("")), "1038:12E0");
    }
}
