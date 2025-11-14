use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::Manager;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MetadataInfo {
    pub file_path: String,
    pub file_name: String,
    pub file_size: u64,
    pub metadata: HashMap<String, String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CleanResult {
    pub success: bool,
    pub file_path: String,
    pub output_path: String,
    pub message: String,
}

pub struct ExifToolWrapper {
    exiftool_path: PathBuf,
}

impl ExifToolWrapper {
    pub fn new(app_handle: &tauri::AppHandle) -> Result<Self, String> {
        let resource_path = app_handle
            .path()
            .resource_dir()
            .map_err(|e| format!("Failed to get resource dir: {}", e))?;

        let exiftool_name = if cfg!(target_os = "macos") {
            if cfg!(target_arch = "aarch64") {
                "exiftool-aarch64-apple-darwin"
            } else {
                "exiftool-x86_64-apple-darwin"
            }
        } else if cfg!(target_os = "linux") {
            if cfg!(target_arch = "aarch64") {
                "exiftool-aarch64-unknown-linux-gnu"
            } else {
                "exiftool-x86_64-unknown-linux-gnu"
            }
        } else if cfg!(target_os = "windows") {
            if cfg!(target_arch = "aarch64") {
                "exiftool-aarch64-pc-windows-msvc.exe"
            } else {
                "exiftool-x86_64-pc-windows-msvc.exe"
            }
        } else {
            return Err("Unsupported platform".to_string());
        };

        let exiftool_path = resource_path.join("binaries").join(exiftool_name);

        if !exiftool_path.exists() {
            return Err(format!(
                "ExifTool binary not found at: {}",
                exiftool_path.display()
            ));
        }

        Ok(Self { exiftool_path })
    }

    pub fn read_metadata(&self, file_path: &str) -> Result<MetadataInfo, String> {
        let path = Path::new(file_path);
        if !path.exists() {
            return Err(format!("File not found: {}", file_path));
        }

        let metadata =
            std::fs::metadata(path).map_err(|e| format!("Failed to read file metadata: {}", e))?;

        let output = Command::new(&self.exiftool_path)
            .arg("-json")
            .arg("-a")
            .arg("-s")
            .arg(file_path)
            .output()
            .map_err(|e| format!("Failed to execute exiftool: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("ExifTool error: {}", stderr));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let json_data: Vec<HashMap<String, serde_json::Value>> = serde_json::from_str(&stdout)
            .map_err(|e| format!("Failed to parse ExifTool output: {}", e))?;

        let mut metadata_map = HashMap::new();
        if let Some(first) = json_data.first() {
            for (key, value) in first.iter() {
                let formatted_value = match value {
                    serde_json::Value::String(s) => s.clone(),
                    serde_json::Value::Number(n) => n.to_string(),
                    serde_json::Value::Bool(b) => b.to_string(),
                    serde_json::Value::Array(arr) => arr
                        .iter()
                        .filter_map(|v| v.as_str())
                        .collect::<Vec<_>>()
                        .join(", "),
                    _ => continue,
                };
                metadata_map.insert(key.clone(), formatted_value);
            }
        }

        Ok(MetadataInfo {
            file_path: file_path.to_string(),
            file_name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string(),
            file_size: metadata.len(),
            metadata: metadata_map,
        })
    }

    pub fn clean_metadata(
        &self,
        file_path: &str,
        backup: bool,
        preserve_orientation: bool,
        preserve_color_profile: bool,
        preserve_modification_date: bool,
    ) -> Result<CleanResult, String> {
        let path = Path::new(file_path);
        if !path.exists() {
            return Err(format!("File not found: {}", file_path));
        }

        let output_path = if !backup {
            let file_stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .ok_or("Invalid file name")?;
            let extension = path.extension().and_then(|s| s.to_str()).unwrap_or("");
            let parent = path.parent().ok_or("Invalid file path")?;

            let output_name = if extension.is_empty() {
                format!("{}_cleaned", file_stem)
            } else {
                format!("{}_cleaned.{}", file_stem, extension)
            };

            parent
                .join(output_name)
                .to_str()
                .ok_or("Failed to create output path")?
                .to_string()
        } else {
            file_path.to_string()
        };

        let mut args = vec!["-all="];

        if let Some(ext) = path.extension() {
            let ext_lower = ext.to_string_lossy().to_lowercase();
            if ext_lower == "tif" || ext_lower == "tiff" {
                args.push("-CommonIFD0=");
            }
        }

        let has_preserved_tags = preserve_orientation || preserve_color_profile;
        if has_preserved_tags {
            args.push("-tagsfromfile");
            args.push("@");

            if preserve_orientation {
                args.push("-Orientation");
            }

            if preserve_color_profile {
                args.push("-ColorSpaceTags");
                args.push("-ICCProfile");
            }
        }

        if preserve_modification_date {
            args.push("-P");
        }

        if !backup {
            args.push("-o");
            args.push(&output_path);
        }

        args.push(file_path);

        let output = Command::new(&self.exiftool_path)
            .args(&args)
            .output()
            .map_err(|e| format!("Failed to execute exiftool: {}", e))?;

        let success = output.status.success();

        let message = if success {
            "Metadata cleaned successfully".to_string()
        } else {
            String::from_utf8_lossy(&output.stderr).to_string()
        };

        Ok(CleanResult {
            success,
            file_path: file_path.to_string(),
            output_path: output_path.clone(),
            message,
        })
    }

    pub fn clean_selective(
        &self,
        file_path: &str,
        tags: Vec<String>,
        backup: bool,
        preserve_modification_date: bool,
    ) -> Result<CleanResult, String> {
        let path = Path::new(file_path);
        if !path.exists() {
            return Err(format!("File not found: {}", file_path));
        }

        let output_path = if !backup {
            let file_stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .ok_or("Invalid file name")?;
            let extension = path.extension().and_then(|s| s.to_str()).unwrap_or("");
            let parent = path.parent().ok_or("Invalid file path")?;

            let output_name = if extension.is_empty() {
                format!("{}_cleaned", file_stem)
            } else {
                format!("{}_cleaned.{}", file_stem, extension)
            };

            parent
                .join(output_name)
                .to_str()
                .ok_or("Failed to create output path")?
                .to_string()
        } else {
            file_path.to_string()
        };

        let mut args = Vec::new();
        let tag_count = tags.len();

        for tag in &tags {
            args.push(format!("-{}=", tag));
        }

        if preserve_modification_date {
            args.push("-P".to_string());
        }

        if !backup {
            args.push("-o".to_string());
            args.push(output_path.clone());
        }

        args.push(file_path.to_string());

        let output = Command::new(&self.exiftool_path)
            .args(&args)
            .output()
            .map_err(|e| format!("Failed to execute exiftool: {}", e))?;

        let success = output.status.success();

        let message = if success {
            format!("Removed {} metadata tags", tag_count)
        } else {
            String::from_utf8_lossy(&output.stderr).to_string()
        };

        Ok(CleanResult {
            success,
            file_path: file_path.to_string(),
            output_path: output_path.clone(),
            message,
        })
    }
}
