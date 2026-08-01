use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use std::time::Instant;
use sysinfo::Networks;

fn throughput_kbps(bytes: u64, elapsed_seconds: f64) -> f64 {
    bytes as f64 / 1024.0 / elapsed_seconds.max(0.001)
}

fn activity(download_kbps: f64, upload_kbps: f64) -> u32 {
    // A logarithmic scale keeps normal browsing visible without making fast transfers exceed 100.
    let total = download_kbps + upload_kbps;
    ((total + 1.0).ln() / 100_001_f64.ln() * 100.0)
        .round()
        .clamp(0.0, 100.0) as u32
}

fn main() {
    let mut networks = Networks::new_with_refreshed_list();
    let mut refreshed_at = Instant::now();

    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            eprintln!("收到无法解析的 JSONL 消息");
            continue;
        };
        match message.get("type").and_then(Value::as_str) {
            Some("shutdown") => break,
            Some("tick") => {
                let elapsed = refreshed_at.elapsed().as_secs_f64();
                networks.refresh(true);
                refreshed_at = Instant::now();
                let received = networks.values().map(|network| network.received()).sum();
                let transmitted = networks.values().map(|network| network.transmitted()).sum();
                let download = throughput_kbps(received, elapsed);
                let upload = throughput_kbps(transmitted, elapsed);
                println!("{}", json!({
                    "type": "result",
                    "requestId": message.get("requestId").cloned().unwrap_or(Value::Null),
                    "variables": {
                        "download_kbps": download.round() as u64,
                        "upload_kbps": upload.round() as u64,
                        "activity": activity(download, upload)
                    },
                    "renders": [],
                    "events": []
                }));
                let _ = io::stdout().flush();
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{activity, throughput_kbps};

    #[test]
    fn converts_bytes_to_kilobytes_per_second() {
        assert_eq!(throughput_kbps(2048, 2.0), 1.0);
    }

    #[test]
    fn activity_is_bounded_and_increases() {
        assert_eq!(activity(0.0, 0.0), 0);
        assert!(activity(1000.0, 0.0) < activity(10_000.0, 0.0));
        assert_eq!(activity(1_000_000.0, 1_000_000.0), 100);
    }
}
