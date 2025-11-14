use crate::exiftool::{CleanResult, ExifToolWrapper, MetadataInfo};
use rayon::prelude::*;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::State;
use walkdir::WalkDir;

pub struct AppState {
    pub exiftool: Arc<Mutex<ExifToolWrapper>>,
}

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
pub async fn read_file_metadata(
    file_path: String,
    state: State<'_, AppState>,
) -> Result<MetadataInfo, String> {
    let exiftool = state.exiftool.lock().map_err(|e| e.to_string())?;
    exiftool.read_metadata(&file_path)
}

#[tauri::command]
pub async fn clean_file_metadata(
    file_path: String,
    backup: bool,
    preserve_orientation: bool,
    preserve_color_profile: bool,
    preserve_modification_date: bool,
    state: State<'_, AppState>,
) -> Result<CleanResult, String> {
    let exiftool = state.exiftool.lock().map_err(|e| e.to_string())?;
    exiftool.clean_metadata(
        &file_path,
        backup,
        preserve_orientation,
        preserve_color_profile,
        preserve_modification_date,
    )
}

#[tauri::command]
pub async fn clean_file_selective(
    file_path: String,
    tags: Vec<String>,
    backup: bool,
    preserve_modification_date: bool,
    state: State<'_, AppState>,
) -> Result<CleanResult, String> {
    let exiftool = state.exiftool.lock().map_err(|e| e.to_string())?;
    exiftool.clean_selective(&file_path, tags, backup, preserve_modification_date)
}

#[tauri::command]
pub async fn clean_multiple_files(
    file_paths: Vec<String>,
    backup: bool,
    preserve_orientation: bool,
    preserve_color_profile: bool,
    preserve_modification_date: bool,
    state: State<'_, AppState>,
) -> Result<Vec<CleanResult>, String> {
    let results: Vec<CleanResult> = file_paths
        .par_iter()
        .filter_map(|file_path| {
            let exiftool = state.exiftool.lock().ok()?;
            exiftool
                .clean_metadata(
                    file_path,
                    backup,
                    preserve_orientation,
                    preserve_color_profile,
                    preserve_modification_date,
                )
                .ok()
        })
        .collect();

    Ok(results)
}

#[tauri::command]
pub async fn read_multiple_metadata(
    file_paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<MetadataInfo>, String> {
    let results: Vec<MetadataInfo> = file_paths
        .par_iter()
        .filter_map(|file_path| {
            let exiftool = state.exiftool.lock().ok()?;
            exiftool.read_metadata(file_path).ok()
        })
        .collect();

    Ok(results)
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
