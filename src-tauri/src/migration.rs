use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const LEGACY_IDENTIFIER: &str = "com.steelseries-oled.app";
const CURRENT_IDENTIFIER: &str = "io.github.xiamuyifeng.nova-display-controller";

fn copy_tree(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&source_path, &destination_path)?;
        } else {
            fs::copy(source_path, destination_path)?;
        }
    }
    Ok(())
}

fn staging_path(destination: &Path) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    destination.with_file_name(format!(
        ".nova-display-migration-{}-{nonce}",
        std::process::id()
    ))
}

fn migrate_directory(source: &Path, destination: &Path) -> std::io::Result<bool> {
    if !source.is_dir() || destination.exists() {
        return Ok(false);
    }

    let staging = staging_path(destination);
    if let Err(error) = copy_tree(source, &staging) {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }

    match fs::rename(&staging, destination) {
        Ok(()) => Ok(true),
        Err(_error) if destination.exists() => {
            let _ = fs::remove_dir_all(&staging);
            Ok(false)
        }
        Err(error) => {
            let _ = fs::remove_dir_all(&staging);
            Err(error)
        }
    }
}

#[cfg(target_os = "windows")]
pub fn migrate_legacy_data() {
    for variable in ["LOCALAPPDATA", "APPDATA"] {
        let Some(root) = std::env::var_os(variable).map(PathBuf::from) else {
            continue;
        };
        let source = root.join(LEGACY_IDENTIFIER);
        let destination = root.join(CURRENT_IDENTIFIER);
        if let Err(error) = migrate_directory(&source, &destination) {
            eprintln!(
                "unable to migrate legacy application data from {}: {error}",
                source.display()
            );
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn migrate_legacy_data() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_copies_once_without_removing_legacy_data() {
        let root = std::env::temp_dir().join(format!(
            "nova-display-migration-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let source = root.join("old");
        let destination = root.join("new");
        fs::create_dir_all(source.join("nested")).unwrap();
        fs::write(source.join("nested").join("data.txt"), b"legacy").unwrap();

        assert!(migrate_directory(&source, &destination).unwrap());
        assert_eq!(
            fs::read(destination.join("nested").join("data.txt")).unwrap(),
            b"legacy"
        );
        assert!(source.join("nested").join("data.txt").exists());
        fs::write(destination.join("current.txt"), b"current").unwrap();
        assert!(!migrate_directory(&source, &destination).unwrap());
        assert_eq!(
            fs::read(destination.join("current.txt")).unwrap(),
            b"current"
        );

        fs::remove_dir_all(root).unwrap();
    }
}
