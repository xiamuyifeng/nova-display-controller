use hidapi::{HidApi, HidDevice, MAX_REPORT_DESCRIPTOR_SIZE};
use std::{thread, time::Duration};

const VENDOR_ID: u16 = 0x1038;
const NOVA_PRO_PIDS: &[u16] = &[0x12CB, 0x12CD, 0x12E0, 0x12E5, 0x225D];

fn descriptor_summary(device: &HidDevice) -> (Option<u8>, Option<u8>) {
    let mut descriptor = [0u8; MAX_REPORT_DESCRIPTOR_SIZE];
    let descriptor_len = device.get_report_descriptor(&mut descriptor).unwrap_or(0);
    let descriptor_type = (descriptor_len > 1).then_some(descriptor[1]);
    let report_id = descriptor
        .windows(2)
        .find(|pair| pair[0] == 0x85)
        .map(|pair| pair[1]);
    (descriptor_type, report_id)
}

fn drain(device: &HidDevice, label: &str) {
    for _ in 0..12 {
        let mut response = [0u8; 64];
        match device.read_timeout(&mut response, 250) {
            Ok(0) => break,
            Ok(len) => {
                println!(
                    "{label} read len={len}, id=0x{:02x}, cmd=0x{:02x}, bytes={:02x?}",
                    response[0],
                    response[1],
                    &response[..16]
                );
            }
            Err(error) => {
                println!("{label} read error: {error}");
                break;
            }
        }
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let api = HidApi::new()?;
    let mut opened = Vec::new();

    for info in api.device_list().filter(|info| {
        info.vendor_id() == VENDOR_ID
            && NOVA_PRO_PIDS.contains(&info.product_id())
            && info.interface_number() == 4
    }) {
        let product = info.product_string().unwrap_or("Unknown SteelSeries");
        println!(
            "candidate: {product}, pid=0x{:04x}, interface={}, usage_page=0x{:04x}, usage=0x{:04x}",
            info.product_id(),
            info.interface_number(),
            info.usage_page(),
            info.usage()
        );
        let device = match info.open_device(&api) {
            Ok(device) => device,
            Err(error) => {
                println!("  open failed: {error}");
                continue;
            }
        };
        let (descriptor_type, report_id) = descriptor_summary(&device);
        println!(
            "  opened: descriptor_type={descriptor_type:02x?}, descriptor_report_id={report_id:02x?}"
        );
        opened.push((device, descriptor_type, report_id));
    }

    let Some(oled_index) = opened
        .iter()
        .position(|(_, descriptor_type, _)| *descriptor_type == Some(0xC0))
    else {
        println!("no oled collection opened");
        return Ok(());
    };
    let (oled, oled_descriptor_type, oled_report_id) = opened.swap_remove(oled_index);
    let Some(info_index) = opened
        .iter()
        .position(|(_, descriptor_type, _)| *descriptor_type == Some(0x00))
    else {
        println!("no info collection opened");
        return Ok(());
    };
    let (info, info_descriptor_type, info_report_id) = opened.swap_remove(info_index);

    println!(
        "using oled collection: descriptor_type={oled_descriptor_type:02x?}, descriptor_report_id={oled_report_id:02x?}"
    );
    println!(
        "using info collection: descriptor_type={info_descriptor_type:02x?}, descriptor_report_id={info_report_id:02x?}"
    );
    drain(&oled, "initial oled");
    drain(&info, "initial info");

    for (target_name, target) in [("oled", &oled), ("info", &info)] {
        for outbound_report_id in [0x06u8, 0x07] {
            for command in [0xB0u8, 0xB7, 0x20] {
                let mut report = [0u8; 64];
                report[0] = outbound_report_id;
                report[1] = command;
                match target.write(&report) {
                    Ok(len) => println!(
                        "write {target_name} len={len}, report_id=0x{outbound_report_id:02x}, command=0x{command:02x}"
                    ),
                    Err(error) => println!(
                        "write {target_name} error, report_id=0x{outbound_report_id:02x}, command=0x{command:02x}: {error}"
                    ),
                }
                thread::sleep(Duration::from_millis(150));
                drain(&oled, "after-write oled");
                drain(&info, "after-write info");
            }
        }
    }

    Ok(())
}
