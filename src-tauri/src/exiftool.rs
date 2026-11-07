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
    qpdf_path: PathBuf,
}

fn is_pdf(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext.to_string_lossy().eq_ignore_ascii_case("pdf"))
}

const QUICKTIME_EXTENSIONS: &[&str] = &[
    "3g2", "3gp2", "3gp", "3gpp", "aax", "f4a", "f4b", "f4p", "f4v", "lrv", "m4a", "m4b", "m4p",
    "m4v", "mov", "mp4", "mqv", "qt",
];

// QuickTime keeps these dates in the movie and track headers, which -all= cannot
// delete, so they are zeroed instead.
const QUICKTIME_DATES: &[&str] = &[
    "QuickTime:CreateDate",
    "QuickTime:ModifyDate",
    "TrackCreateDate",
    "TrackModifyDate",
    "MediaCreateDate",
    "MediaModifyDate",
];

// A copy must stay as private as the file it was made from.
fn copy_permissions(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::metadata(from)
        .and_then(|metadata| std::fs::set_permissions(to, metadata.permissions()))
        .map_err(|e| format!("Failed to copy file permissions: {}", e))
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    path.with_file_name(format!(".{}.metadatazero-{}.pdf", stem, suffix))
}

fn output_path_for(path: &Path, overwrite: bool) -> Result<String, String> {
    if overwrite {
        return Ok(path.to_string_lossy().to_string());
    }
    let file_stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("Invalid file name")?;
    let parent = path.parent().ok_or("Invalid file path")?;
    let output_name = match path.extension().and_then(|s| s.to_str()) {
        Some(extension) => format!("{}_metadatazero.{}", file_stem, extension),
        None => format!("{}_metadatazero", file_stem),
    };
    Ok(parent.join(output_name).to_string_lossy().to_string())
}

fn clean_result(
    file_path: &str,
    overwrite: bool,
    result: Result<String, String>,
    done: String,
) -> CleanResult {
    let fallback = output_path_for(Path::new(file_path), overwrite).unwrap_or_default();
    match result {
        Ok(output_path) => CleanResult {
            success: true,
            file_path: file_path.to_string(),
            output_path,
            message: done,
        },
        Err(message) => CleanResult {
            success: false,
            file_path: file_path.to_string(),
            output_path: fallback,
            message,
        },
    }
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
        } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
            "exiftool-x86_64-pc-windows-msvc.exe"
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

        let qpdf_name = if cfg!(target_os = "windows") {
            "qpdf.exe"
        } else {
            "qpdf"
        };
        let qpdf_path = resource_path
            .join("binaries")
            .join("qpdf")
            .join("bin")
            .join(qpdf_name);

        if !qpdf_path.exists() {
            return Err(format!("QPDF binary not found at: {}", qpdf_path.display()));
        }

        Ok(Self {
            exiftool_path,
            qpdf_path,
        })
    }

    fn run_exiftool(&self, args: &[String]) -> Result<(), String> {
        let output = Command::new(&self.exiftool_path)
            .args(args)
            .output()
            .map_err(|e| format!("Failed to execute exiftool: {}", e))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).to_string())
        }
    }

    // QPDF exits with 3 when it succeeds with warnings, which damaged but readable
    // PDFs often trigger.
    fn rewrite_pdf(&self, input: &Path, output: &Path) -> Result<(), String> {
        let result = Command::new(&self.qpdf_path)
            .arg(input)
            .arg(output)
            .output()
            .map_err(|e| format!("Failed to execute qpdf: {}", e))?;
        match result.status.code() {
            Some(0) | Some(3) => Ok(()),
            _ => Err(format!(
                "QPDF could not rewrite the PDF: {}",
                String::from_utf8_lossy(&result.stderr)
            )),
        }
    }

    // ExifTool edits a PDF by appending an update, so the removed values stay in the
    // file and can be restored. QPDF rewrites only the objects still in use, which
    // drops them for good. Both steps write to temporary files next to the original
    // so a failure never leaves a half-cleaned file behind.
    fn write_cleaned(
        &self,
        file_path: &str,
        mut args: Vec<String>,
        overwrite: bool,
        preserve_modification_date: bool,
    ) -> Result<String, String> {
        let path = Path::new(file_path);
        let output_path = output_path_for(path, overwrite)?;

        if preserve_modification_date {
            args.push("-P".to_string());
        }

        if !is_pdf(path) {
            if overwrite {
                args.push("-overwrite_original".to_string());
            } else {
                args.push("-o".to_string());
                args.push(output_path.clone());
            }
            args.push(file_path.to_string());
            self.run_exiftool(&args)?;
            if !overwrite {
                copy_permissions(path, Path::new(&output_path))?;
            }
            return Ok(output_path);
        }

        if !overwrite && Path::new(&output_path).exists() {
            return Err(format!("{} already exists", output_path));
        }

        let modified = std::fs::metadata(path).and_then(|m| m.modified()).ok();
        let edited = sibling(path, "edited");
        let rewritten = sibling(path, "rewritten");
        let _ = std::fs::remove_file(&edited);
        let _ = std::fs::remove_file(&rewritten);

        args.push("-o".to_string());
        args.push(edited.to_string_lossy().to_string());
        args.push(file_path.to_string());

        let result = self
            .run_exiftool(&args)
            .and_then(|_| self.rewrite_pdf(&edited, &rewritten))
            .and_then(|_| copy_permissions(path, &rewritten))
            .and_then(|_| std::fs::rename(&rewritten, &output_path).map_err(|e| e.to_string()));

        let _ = std::fs::remove_file(&edited);
        let _ = std::fs::remove_file(&rewritten);
        result?;

        if preserve_modification_date {
            if let Some(time) = modified {
                let _ = std::fs::File::options()
                    .write(true)
                    .open(&output_path)
                    .and_then(|file| file.set_modified(time));
            }
        }

        Ok(output_path)
    }

    pub fn version(&self) -> Result<String, String> {
        let output = Command::new(&self.exiftool_path)
            .arg("-ver")
            .output()
            .map_err(|e| format!("Failed to execute exiftool: {}", e))?;
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
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
        overwrite: bool,
        preserve_orientation: bool,
        preserve_color_profile: bool,
        preserve_modification_date: bool,
    ) -> Result<CleanResult, String> {
        let path = Path::new(file_path);
        if !path.exists() {
            return Err(format!("File not found: {}", file_path));
        }

        let mut args = vec!["-all=".to_string()];

        if let Some(ext) = path.extension() {
            let ext_lower = ext.to_string_lossy().to_lowercase();
            if ext_lower == "tif" || ext_lower == "tiff" {
                args.push("-CommonIFD0=".to_string());
                if !preserve_orientation {
                    args.push("-IFD0:Orientation=".to_string());
                }
            }
            if QUICKTIME_EXTENSIONS.contains(&ext_lower.as_str()) {
                for tag in QUICKTIME_DATES {
                    args.push(format!("-{}=0000:00:00 00:00:00", tag));
                }
            }
        }

        if preserve_orientation || preserve_color_profile {
            args.push("-tagsfromfile".to_string());
            args.push("@".to_string());

            if preserve_orientation {
                args.push("-Orientation".to_string());
            }

            if preserve_color_profile {
                args.push("-ColorSpaceTags".to_string());
                args.push("-ICCProfile".to_string());
            }
        }

        let result = self.write_cleaned(file_path, args, overwrite, preserve_modification_date);
        Ok(clean_result(
            file_path,
            overwrite,
            result,
            "Metadata cleaned successfully".to_string(),
        ))
    }

    pub fn clean_selective(
        &self,
        file_path: &str,
        tags: Vec<String>,
        overwrite: bool,
        preserve_modification_date: bool,
    ) -> Result<CleanResult, String> {
        if !Path::new(file_path).exists() {
            return Err(format!("File not found: {}", file_path));
        }

        let tag_count = tags.len();
        let args = tags.iter().map(|tag| format!("-{}=", tag)).collect();
        let result = self.write_cleaned(file_path, args, overwrite, preserve_modification_date);
        Ok(clean_result(
            file_path,
            overwrite,
            result,
            format!("Removed {} metadata tags", tag_count),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "Camille Durand";

    fn wrapper() -> ExifToolWrapper {
        let binaries = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
        let exiftool = if cfg!(target_os = "windows") {
            "exiftool-x86_64-pc-windows-msvc.exe".to_string()
        } else {
            let os = if cfg!(target_os = "macos") {
                "apple-darwin"
            } else {
                "unknown-linux-gnu"
            };
            format!("exiftool-{}-{}", std::env::consts::ARCH, os)
        };
        let qpdf = if cfg!(target_os = "windows") {
            "qpdf.exe"
        } else {
            "qpdf"
        };
        ExifToolWrapper {
            exiftool_path: binaries.join(exiftool),
            qpdf_path: binaries.join("qpdf").join("bin").join(qpdf),
        }
    }

    fn write_pdf(path: &Path) {
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>".to_string(),
            format!("<< /Author ({}) /Title (Lease agreement) >>", SECRET),
        ];
        let mut pdf = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (i, body) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.extend(format!("{} 0 obj\n{}\nendobj\n", i + 1, body).as_bytes());
        }
        let xref = pdf.len();
        pdf.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
        for offset in offsets {
            pdf.extend(format!("{:010} 00000 n \n", offset).as_bytes());
        }
        pdf.extend(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R /Info 4 0 R >>\nstartxref\n{}\n%%EOF\n",
                objects.len() + 1,
                xref
            )
            .as_bytes(),
        );
        std::fs::write(path, pdf).unwrap();
    }

    fn contains_secret(path: &Path) -> bool {
        let bytes = std::fs::read(path).unwrap();
        bytes.windows(SECRET.len()).any(|w| w == SECRET.as_bytes())
    }

    fn scratch(name: &str) -> PathBuf {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let unique = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "metadatazero-test-{}-{}-{}",
            name,
            std::process::id(),
            unique
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const ZERO_DATE: &str = "0000:00:00 00:00:00";

    const IDENTIFYING: &[&str] = &[
        "Artist",
        "Make",
        "Model",
        "Software",
        "DateTimeOriginal",
        "CreateDate",
        "GPSLatitude",
        "GPSLongitude",
        "GPSPosition",
        "GPSCoordinates",
    ];

    fn fixture(name: &str, dir: &Path) -> PathBuf {
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join(name);
        let target = dir.join(name);
        std::fs::copy(source, &target).unwrap();
        target
    }

    fn fields(path: &Path) -> HashMap<String, String> {
        wrapper()
            .read_metadata(path.to_str().unwrap())
            .unwrap()
            .metadata
    }

    fn clean_copy(name: &str, orientation: bool, color_profile: bool) -> HashMap<String, String> {
        let dir = scratch(&format!("{}-{}-{}", name, orientation, color_profile));
        let original = fixture(name, &dir);
        let result = wrapper()
            .clean_metadata(
                original.to_str().unwrap(),
                false,
                orientation,
                color_profile,
                false,
            )
            .unwrap();
        assert!(result.success, "{}: {}", name, result.message);
        fields(Path::new(&result.output_path))
    }

    #[test]
    fn fixtures_carry_the_metadata_under_test() {
        for name in [
            "photo.jpg",
            "photo.png",
            "photo.tiff",
            "photo.heic",
            "video.mp4",
        ] {
            let dir = scratch(&format!("fixture-{}", name));
            let found = fields(&fixture(name, &dir));
            assert_eq!(
                found.get("Artist").map(String::as_str),
                Some("Camille Durand"),
                "{}",
                name
            );
        }
    }

    #[test]
    fn identifying_fields_are_removed_from_every_format() {
        for name in [
            "photo.jpg",
            "photo.png",
            "photo.tiff",
            "photo.heic",
            "video.mp4",
        ] {
            let left = clean_copy(name, false, false);
            for key in IDENTIFYING {
                assert!(
                    left.get(*key).is_none_or(|value| value == ZERO_DATE),
                    "{} still has {}: {:?}",
                    name,
                    key,
                    left.get(*key)
                );
            }
        }
    }

    #[test]
    fn orientation_is_removed_unless_kept() {
        for name in ["photo.jpg", "photo.tiff", "photo.heic"] {
            assert!(
                !clean_copy(name, false, false).contains_key("Orientation"),
                "{}",
                name
            );
            let kept = clean_copy(name, true, false);
            assert_eq!(
                kept.get("Orientation").map(String::as_str),
                Some("Rotate 90 CW"),
                "{}",
                name
            );
            for key in IDENTIFYING {
                assert!(
                    !kept.contains_key(*key),
                    "{} kept {} along with orientation",
                    name,
                    key
                );
            }
        }
    }

    #[test]
    fn color_profile_is_removed_unless_kept() {
        for name in ["photo.jpg", "photo.png", "photo.tiff", "photo.heic"] {
            // HEIC stores the profile as an image property ExifTool cannot delete. It
            // is the standard profile of the screen, nothing personal.
            if name != "photo.heic" {
                assert!(
                    !clean_copy(name, false, false).contains_key("ProfileDescription"),
                    "{}",
                    name
                );
            }
            let kept = clean_copy(name, false, true);
            assert_eq!(
                kept.get("ProfileDescription").map(String::as_str),
                Some("Display P3"),
                "{}",
                name
            );
            for key in IDENTIFYING {
                assert!(
                    !kept.contains_key(*key),
                    "{} kept {} along with the color profile",
                    name,
                    key
                );
            }
        }
    }

    #[test]
    fn replacing_a_photo_leaves_no_backup_with_the_metadata() {
        let dir = scratch("replace-photo");
        let original = fixture("photo.jpg", &dir);
        let result = wrapper()
            .clean_metadata(original.to_str().unwrap(), true, false, false, false)
            .unwrap();
        assert!(result.success, "{}", result.message);
        assert!(!fields(&original).contains_key("Artist"));
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    }

    #[test]
    fn an_existing_copy_is_never_overwritten() {
        let dir = scratch("existing-copy");
        let original = fixture("photo.jpg", &dir);
        std::fs::write(dir.join("photo_metadatazero.jpg"), b"keep me").unwrap();
        let result = wrapper()
            .clean_metadata(original.to_str().unwrap(), false, false, false, false)
            .unwrap();
        assert!(!result.success);
        assert_eq!(
            std::fs::read(dir.join("photo_metadatazero.jpg")).unwrap(),
            b"keep me"
        );
    }

    #[cfg(unix)]
    #[test]
    fn copies_stay_as_private_as_the_original() {
        use std::os::unix::fs::PermissionsExt;
        for name in ["photo.jpg", "video.mp4"] {
            let dir = scratch(&format!("private-{}", name));
            let original = fixture(name, &dir);
            std::fs::set_permissions(&original, std::fs::Permissions::from_mode(0o600)).unwrap();
            let result = wrapper()
                .clean_metadata(original.to_str().unwrap(), false, false, false, false)
                .unwrap();
            assert!(result.success, "{}", result.message);
            let mode = std::fs::metadata(&result.output_path)
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "{}", name);
        }
        let dir = scratch("private-pdf");
        let original = dir.join("lease.pdf");
        write_pdf(&original);
        std::fs::set_permissions(&original, std::fs::Permissions::from_mode(0o600)).unwrap();
        for overwrite in [false, true] {
            let result = wrapper()
                .clean_metadata(original.to_str().unwrap(), overwrite, false, false, false)
                .unwrap();
            assert!(result.success, "{}", result.message);
            let mode = std::fs::metadata(&result.output_path)
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "pdf overwrite={}", overwrite);
        }
    }

    #[test]
    fn exiftool_alone_leaves_pdf_metadata_recoverable() {
        let dir = scratch("exiftool-alone");
        let original = dir.join("lease.pdf");
        let edited = dir.join("edited.pdf");
        write_pdf(&original);

        wrapper()
            .run_exiftool(&[
                "-all=".into(),
                "-o".into(),
                edited.to_string_lossy().into(),
                original.to_string_lossy().into(),
            ])
            .unwrap();

        assert!(contains_secret(&edited));
    }

    #[test]
    fn cleaned_pdf_copy_has_no_trace_of_the_metadata() {
        let dir = scratch("copy");
        let original = dir.join("lease.pdf");
        write_pdf(&original);

        let result = wrapper()
            .clean_metadata(original.to_str().unwrap(), false, false, false, false)
            .unwrap();

        assert!(result.success, "{}", result.message);
        let copy = dir.join("lease_metadatazero.pdf");
        assert_eq!(Path::new(&result.output_path), copy);
        assert!(!contains_secret(&copy));
        assert!(contains_secret(&original));
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2);
    }

    #[test]
    fn replaced_pdf_keeps_its_date_and_loses_the_metadata() {
        let dir = scratch("replace");
        let original = dir.join("lease.pdf");
        write_pdf(&original);
        let old = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        std::fs::File::options()
            .write(true)
            .open(&original)
            .unwrap()
            .set_modified(old)
            .unwrap();

        let result = wrapper()
            .clean_metadata(original.to_str().unwrap(), true, false, false, true)
            .unwrap();

        assert!(result.success, "{}", result.message);
        assert!(!contains_secret(&original));
        assert_eq!(
            std::fs::metadata(&original).unwrap().modified().unwrap(),
            old
        );
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    }
}
