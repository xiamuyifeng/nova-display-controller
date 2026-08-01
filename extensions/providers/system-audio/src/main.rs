use serde_json::{json, Value};
use std::collections::VecDeque;
use std::f32::consts::PI;
use std::io::{self, BufRead, Write};
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator,
    MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_LOOPBACK,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED,
};

struct AudioCapture {
    client: IAudioClient,
    capture: IAudioCaptureClient,
    channels: usize,
    sample_rate: f32,
    bits: u16,
    float_samples: bool,
    samples: VecDeque<f32>,
    smoothed: [f32; 32],
    was_active: bool,
}

impl AudioCapture {
    unsafe fn new() -> windows::core::Result<Self> {
        CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
        let client: IAudioClient = device.Activate(CLSCTX_ALL, None)?;
        let format = client.GetMixFormat()?;
        let channels = (*format).nChannels.max(1) as usize;
        let sample_rate = (*format).nSamplesPerSec as f32;
        let bits = (*format).wBitsPerSample;
        let float_samples = (*format).wFormatTag == 3 || ((*format).wFormatTag == 0xfffe && bits == 32);
        client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK,
            10_000_000,
            0,
            format,
            None,
        )?;
        CoTaskMemFree(Some(format.cast()));
        let capture: IAudioCaptureClient = client.GetService()?;
        client.Start()?;
        Ok(Self {
            client,
            capture,
            channels,
            sample_rate,
            bits,
            float_samples,
            samples: VecDeque::with_capacity(4096),
            smoothed: [0.0; 32],
            was_active: false,
        })
    }

    unsafe fn drain(&mut self) -> windows::core::Result<usize> {
        let mut captured = 0_usize;
        loop {
            let packet = self.capture.GetNextPacketSize()?;
            if packet == 0 {
                break;
            }
            let mut data = std::ptr::null_mut();
            let mut frames = 0_u32;
            let mut flags = 0_u32;
            self.capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;
            let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0;
            for frame in 0..frames as usize {
                let sample = if silent {
                    0.0
                } else {
                    self.read_frame(data, frame)
                };
                if self.samples.len() >= 4096 {
                    self.samples.pop_front();
                }
                self.samples.push_back(sample.clamp(-1.0, 1.0));
                captured += 1;
            }
            self.capture.ReleaseBuffer(frames)?;
        }
        if captured == 0 {
            let decay_samples = (self.sample_rate as usize / 30).clamp(256, 2048);
            for _ in 0..decay_samples {
                if self.samples.len() >= 4096 {
                    self.samples.pop_front();
                }
                self.samples.push_back(0.0);
            }
        }
        Ok(captured)
    }

    unsafe fn read_frame(&self, data: *const u8, frame: usize) -> f32 {
        let bytes_per_sample = (self.bits as usize / 8).max(1);
        let base = frame * self.channels * bytes_per_sample;
        let mut sum = 0.0;
        for channel in 0..self.channels {
            let pointer = data.add(base + channel * bytes_per_sample);
            let value = if self.float_samples && self.bits == 32 {
                std::ptr::read_unaligned(pointer.cast::<f32>())
            } else if self.bits == 16 {
                std::ptr::read_unaligned(pointer.cast::<i16>()) as f32 / i16::MAX as f32
            } else if self.bits == 32 {
                std::ptr::read_unaligned(pointer.cast::<i32>()) as f32 / i32::MAX as f32
            } else if self.bits == 24 {
                let raw = (*pointer as i32) | ((*pointer.add(1) as i32) << 8) | ((*pointer.add(2) as i32) << 16);
                ((raw << 8) >> 8) as f32 / 8_388_607.0
            } else {
                0.0
            };
            sum += value;
        }
        sum / self.channels as f32
    }

    fn analyze(&mut self, bars: usize, gain: f32, smoothing: f32) -> (f32, Vec<f32>) {
        let count = self.samples.len().min(1024);
        if count < 64 {
            return (0.0, vec![0.0; bars]);
        }
        let recent: Vec<f32> = self.samples.iter().skip(self.samples.len() - count).copied().collect();
        let rms = (recent.iter().map(|sample| sample * sample).sum::<f32>() / count as f32).sqrt();
        let max_frequency = (self.sample_rate * 0.45).min(14_000.0);
        let mut levels = Vec::with_capacity(bars);
        for bar in 0..bars {
            let ratio = (bar as f32 + 0.5) / bars as f32;
            let frequency = 55.0 * (max_frequency / 55.0).powf(ratio);
            let omega = 2.0 * PI * frequency / self.sample_rate;
            let mut real = 0.0;
            let mut imaginary = 0.0;
            for (index, sample) in recent.iter().enumerate() {
                let window = 0.5 - 0.5 * (2.0 * PI * index as f32 / (count - 1) as f32).cos();
                let phase = omega * index as f32;
                real += sample * window * phase.cos();
                imaginary -= sample * window * phase.sin();
            }
            let amplitude = (real * real + imaginary * imaginary).sqrt() / count as f32 * gain * 2.0;
            let magnitude = ((20.0 * amplitude.max(0.000_001).log10() + 70.0) / 70.0).clamp(0.0, 1.0);
            self.smoothed[bar] = self.smoothed[bar] * smoothing + magnitude * (1.0 - smoothing);
            levels.push(self.smoothed[bar]);
        }
        (rms, levels)
    }
}

impl Drop for AudioCapture {
    fn drop(&mut self) {
        unsafe { let _ = self.client.Stop(); }
    }
}

fn number(settings: &Value, key: &str, fallback: f32) -> f32 {
    settings.get(key).and_then(Value::as_f64).map(|value| value as f32).unwrap_or(fallback)
}

fn render_pixels(render: &Value, levels: &[f32]) -> Vec<usize> {
    let width = render.get("width").and_then(Value::as_u64).unwrap_or(1).clamp(1, 128) as usize;
    let height = render.get("height").and_then(Value::as_u64).unwrap_or(1).clamp(1, 64) as usize;
    let filled = render.pointer("/settings/filled").and_then(Value::as_bool).unwrap_or(true);
    let mut pixels = Vec::new();
    for (bar, level) in levels.iter().enumerate() {
        let start = bar * width / levels.len();
        let end = (((bar + 1) * width / levels.len()).saturating_sub(1)).max(start + 1).min(width);
        if *level < 0.015 {
            continue;
        }
        let top = height.saturating_sub((level * height as f32).round().max(1.0) as usize);
        for x in start..end {
            for y in top..height {
                if filled || y == top || y + 1 == height || x == start || x + 1 == end {
                    pixels.push(y * width + x);
                }
            }
        }
    }
    pixels
}

fn main() {
    let mut audio = match unsafe { AudioCapture::new() } {
        Ok(audio) => audio,
        Err(error) => {
            eprintln!("无法初始化 Windows 系统音频采集：{error}");
            std::process::exit(2);
        }
    };
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            eprintln!("收到无法解析的 JSONL 消息");
            continue;
        };
        if message.get("type").and_then(Value::as_str) == Some("shutdown") {
            break;
        }
        if message.get("type").and_then(Value::as_str) != Some("tick") {
            continue;
        }
        if let Err(error) = unsafe { audio.drain() } {
            println!("{}", json!({ "type": "error", "message": format!("音频采集失败：{error}") }));
            let _ = io::stdout().flush();
            continue;
        }
        let renders = message.get("renders").and_then(Value::as_array).cloned().unwrap_or_default();
        let settings = renders.first().and_then(|render| render.get("settings")).cloned().unwrap_or_else(|| json!({}));
        let bars = number(&settings, "bars", 16.0).round().clamp(4.0, 32.0) as usize;
        let gain = number(&settings, "gain", 2.2).clamp(0.5, 6.0);
        let smoothing = number(&settings, "smoothing", 0.68).clamp(0.0, 0.92);
        let (rms, levels) = audio.analyze(bars, gain, smoothing);
        let active = rms >= 0.006;
        let events = if active != audio.was_active {
            audio.was_active = active;
            vec![json!({ "name": if active { "audio_started" } else { "audio_stopped" }, "data": { "rms": (rms * 250.0).round() } })]
        } else {
            Vec::new()
        };
        let frames: Vec<Value> = renders.iter().map(|render| json!({
            "id": render.get("id").and_then(Value::as_str).unwrap_or_default(),
            "pixels": render_pixels(render, &levels),
        })).collect();
        println!("{}", json!({
            "type": "result",
            "requestId": message.get("requestId").cloned().unwrap_or(Value::Null),
            "variables": { "rms": (rms * 250.0).round().clamp(0.0, 100.0) as u32 },
            "renders": frames,
            "events": events,
        }));
        let _ = io::stdout().flush();
    }
}
