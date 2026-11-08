use crate::exiftool::{CleanResult, ExifToolWrapper, MetadataInfo};
use serde::Serialize;
use std::path::Path;
use tauri::State;
use walkdir::WalkDir;

fn is_supported_file(path: &Path) -> bool {
    const SUPPORTED_EXTENSIONS: &[&str] = &[
        "3g2", "3gp2", "3gp", "3gpp", "aax", "ai", "ait", "arq", "arw", "avif", "cr2", "cr3",
        "crm", "crw", "ciff", "cs1", "dcp", "dng", "dr4", "dvb", "eps", "epsf", "ps", "erf", "exv",
        "f4a", "f4b", "f4p", "f4v", "fff", "flif", "gif", "gpr", "hdp", "wdp", "jxr", "heic",
        "heif", "iiq", "ind", "indd", "indt", "insp", "jp2", "jpf", "jpm", "jpx", "jpeg", "jpg",
        "jpe", "lrv", "m4a", "m4b", "m4p", "m4v", "mef", "mie", "mos", "mov", "qt", "mp4", "mpo",
        "mqv", "nef", "nrw", "orf", "pdf", "pef", "png", "jng", "mng", "ppm", "pbm", "pgm", "psd",
        "psb", "psdt", "qtif", "qti", "qif", "raf", "raw", "rw2", "rwl", "sr2", "srw", "thm",
        "tiff", "tif", "x3f", "webp",
    ];

    if let Some(extension) = path.extension() {
        let ext = extension.to_string_lossy().to_lowercase();
        SUPPORTED_EXTENSIONS.contains(&ext.as_str())
    } else {
        false
    }
}

#[tauri::command]
pub fn take_pending_files(pending: State<'_, crate::PendingFiles>) -> Vec<String> {
    pending
        .0
        .lock()
        .map(|mut files| std::mem::take(&mut *files))
        .unwrap_or_default()
}

// latest.json only points to the macOS app, the NSIS installer and the AppImage, so
// any other install would download an update it cannot apply. The Flatpak is built
// without a bundle type and is updated by flatpak itself.
#[tauri::command]
pub fn updates_supported() -> bool {
    use tauri::utils::{config::BundleType, platform::bundle_type};
    matches!(
        bundle_type(),
        Some(BundleType::App | BundleType::Nsis | BundleType::AppImage)
    )
}

#[derive(Serialize)]
pub struct ReadOutcome {
    file_path: String,
    info: Option<MetadataInfo>,
    error: Option<String>,
}

#[tauri::command]
pub async fn read_files_metadata(
    file_paths: Vec<String>,
    exiftool: State<'_, ExifToolWrapper>,
) -> Result<Vec<ReadOutcome>, String> {
    Ok(exiftool
        .read_many(&file_paths)
        .into_iter()
        .zip(file_paths)
        .map(|(result, file_path)| match result {
            Ok(info) => ReadOutcome {
                file_path,
                info: Some(info),
                error: None,
            },
            Err(error) => ReadOutcome {
                file_path,
                info: None,
                error: Some(error),
            },
        })
        .collect())
}

#[tauri::command]
pub async fn clean_file_metadata(
    file_path: String,
    overwrite: bool,
    preserve_orientation: bool,
    preserve_color_profile: bool,
    preserve_modification_date: bool,
    exiftool: State<'_, ExifToolWrapper>,
) -> Result<CleanResult, String> {
    exiftool.clean_metadata(
        &file_path,
        overwrite,
        preserve_orientation,
        preserve_color_profile,
        preserve_modification_date,
    )
}

#[tauri::command]
pub async fn expand_paths(paths: Vec<String>) -> Result<Vec<String>, String> {
    let mut file_paths = Vec::new();

    for path_str in paths {
        let path = Path::new(&path_str);

        if path.is_file() {
            if is_supported_file(path) {
                file_paths.push(path_str);
            }
        } else if path.is_dir() {
            for entry in WalkDir::new(path)
                .follow_links(false)
                .into_iter()
                .filter_map(|e| e.ok())
            {
                if entry.file_type().is_file() {
                    if is_supported_file(entry.path()) {
                        if let Some(path_str) = entry.path().to_str() {
                            file_paths.push(path_str.to_string());
                        }
                    }
                }
            }
        }
    }

    Ok(file_paths)
}
