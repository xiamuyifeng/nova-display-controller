use image::{DynamicImage, GrayImage, ImageReader};
use std::io::Cursor;
#[cfg(debug_assertions)]
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;
use tauri::State;

use crate::device::DeviceState;

const OLED_W: u32 = 128;
const OLED_H: u32 = 64;
const CMD_DRAW: u8 = 0x93;
const MAX_SEND_RETRIES: u32 = 10;
#[cfg(debug_assertions)]
static FRAME_LOGGED: AtomicBool = AtomicBool::new(false);

fn image_to_mono(img: &DynamicImage) -> Vec<u8> {
    let resized = img.resize_exact(OLED_W, OLED_H, image::imageops::FilterType::Lanczos3);
    let gray = resized.to_luma8();
    let mut pixels: Vec<i16> = gray.pixels().map(|pixel| pixel.0[0] as i16).collect();
    let width = OLED_W as usize;
    let height = OLED_H as usize;

    for y in 0..height {
        for x in 0..width {
            let index = y * width + x;
            let old = pixels[index];
            let new_value = if old > 127 { 255 } else { 0 };
            pixels[index] = new_value;
            let error = old - new_value;
            if x + 1 < width {
                pixels[index + 1] += error * 7 / 16;
            }
            if y + 1 < height {
                if x > 0 {
                    pixels[(y + 1) * width + x - 1] += error * 3 / 16;
                }
                pixels[(y + 1) * width + x] += error * 5 / 16;
                if x + 1 < width {
                    pixels[(y + 1) * width + x + 1] += error / 16;
                }
            }
        }
    }

    let mut packed = vec![0u8; (OLED_W * OLED_H / 8) as usize];
    for x in 0..width {
        for y in 0..height {
            if pixels[y * width + x] > 127 {
                packed[x * (height / 8) + y / 8] |= 1 << (y % 8);
            }
        }
    }
    packed
}

fn send_report(device: &hidapi::HidDevice, report: &[u8]) -> Result<(), String> {
    let mut retries = 0u32;
    loop {
        match device.send_feature_report(report) {
            Ok(_) => return Ok(()),
            Err(_error) if retries < MAX_SEND_RETRIES => {
                retries += 1;
                thread::sleep(Duration::from_millis(u64::from(retries.pow(2))));
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

fn send_buffer(device: &hidapi::HidDevice, report_id: u8, buffer: &[u8]) -> Result<(), String> {
    for chunk in 0..2usize {
        let mut report = [0u8; 1024];
        report[0] = report_id;
        report[1] = CMD_DRAW;
        report[2] = (chunk * 64) as u8;
        report[3] = 0;
        report[4] = 64;
        report[5] = OLED_H as u8;
        let source = chunk * 512;
        report[6..518].copy_from_slice(&buffer[source..source + 512]);
        send_report(device, &report)?;
    }
    Ok(())
}

#[tauri::command]
pub fn send_frame(state: State<DeviceState>, frame: Vec<u8>) -> Result<(), String> {
    if frame.len() != 1024 {
        return Err(format!("帧数据长度应为 1024 字节，实际为 {}", frame.len()));
    }
    let guard = state.device.lock().map_err(|_| "设备状态锁已损坏")?;
    let connection = guard.as_ref().ok_or("设备未连接")?;
    let result = send_buffer(&connection.oled, connection.oled_report_id, &frame);
    #[cfg(debug_assertions)]
    if result.is_ok() && !FRAME_LOGGED.swap(true, Ordering::Relaxed) {
        eprintln!("[display] first 1024-byte frame sent successfully");
    }
    result
}

#[tauri::command]
pub fn send_image(state: State<DeviceState>, image_data: Vec<u8>) -> Result<(), String> {
    let image = ImageReader::new(Cursor::new(&image_data))
        .with_guessed_format()
        .map_err(|error| error.to_string())?
        .decode()
        .map_err(|error| error.to_string())?;
    let frame = image_to_mono(&image);
    let guard = state.device.lock().map_err(|_| "设备状态锁已损坏")?;
    let connection = guard.as_ref().ok_or("设备未连接")?;
    send_buffer(&connection.oled, connection.oled_report_id, &frame)
}

#[tauri::command]
pub fn send_text(state: State<DeviceState>, _text: String, _font_size: u8) -> Result<(), String> {
    let image = DynamicImage::ImageLuma8(GrayImage::new(OLED_W, OLED_H));
    let frame = image_to_mono(&image);
    let guard = state.device.lock().map_err(|_| "设备状态锁已损坏")?;
    let connection = guard.as_ref().ok_or("设备未连接")?;
    send_buffer(&connection.oled, connection.oled_report_id, &frame)
}

#[tauri::command]
pub fn stop_display(state: State<DeviceState>) -> Result<(), String> {
    state
        .return_to_base_ui()?
        .then_some(())
        .ok_or_else(|| "设备未连接".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn produces_one_kibibyte_frame() {
        let image = DynamicImage::new_luma8(OLED_W, OLED_H);
        assert_eq!(image_to_mono(&image).len(), 1024);
    }
}
