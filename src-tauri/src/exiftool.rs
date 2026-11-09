use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use tauri::Manager;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MetadataInfo {
    pub file_path: String,
    pub file_name: String,
    pub file_size: u64,
    pub metadata: HashMap<String, String>,
    pub removable: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CleanResult {
    pub success: bool,
    pub file_path: String,
    pub output_path: String,
    pub message: String,
}

#[derive(Clone)]
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

fn binary_paths(binaries: &Path) -> Result<(PathBuf, PathBuf), String> {
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
    let qpdf_name = if cfg!(target_os = "windows") {
        "qpdf.exe"
    } else {
        "qpdf"
    };
    Ok((
        binaries.join(exiftool_name),
        binaries.join("qpdf").join("bin").join(qpdf_name),
    ))
}

fn tool(path: &Path) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

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

// The QPDF build for macOS needs an OpenSSL module it does not ship to decrypt RC4,
// the encryption older PDF writers used to lock printing or copying.
const OLD_ENCRYPTION: &str =
    "This PDF is protected with an old encryption that MetadataZero cannot rewrite yet. The file was not changed.";

const PNG_IMAGE: &[&str] = &[
    "ImageWidth",
    "ImageHeight",
    "BitDepth",
    "ColorType",
    "Compression",
    "Filter",
    "Interlace",
    "Gamma",
    "SRGBRendering",
    "PixelsPerUnitX",
    "PixelsPerUnitY",
    "PixelUnits",
    "WhitePointX",
    "WhitePointY",
    "RedX",
    "RedY",
    "GreenX",
    "GreenY",
    "BlueX",
    "BlueY",
];

const TIFF_IMAGE: &[&str] = &[
    "SubfileType",
    "ImageWidth",
    "ImageHeight",
    "BitsPerSample",
    "Compression",
    "PhotometricInterpretation",
    "FillOrder",
    "StripOffsets",
    "SamplesPerPixel",
    "RowsPerStrip",
    "StripByteCounts",
    "XResolution",
    "YResolution",
    "PlanarConfiguration",
    "ResolutionUnit",
    "Predictor",
    "ColorMap",
    "TileWidth",
    "TileLength",
    "TileOffsets",
    "TileByteCounts",
    "ExtraSamples",
    "SampleFormat",
];

// Fields that describe the file itself, such as its size, codec or pixel layout,
// survive any cleaning and say nothing about the person, so they are not counted.
fn is_structural(group0: &str, group1: &str, tag: &str, value: &str) -> bool {
    if value == "0000:00:00 00:00:00" {
        return true;
    }
    match group0 {
        // APP14 tells decoders how a JPEG stores its colors, CMYK ones need it.
        "ExifTool" | "File" | "Composite" | "ICC_Profile" | "APP14" | "" => true,
        "QuickTime" => {
            !matches!(group1, "Keys" | "ItemList" | "UserData") && !tag.ends_with("Date")
        }
        "PNG" => group1 == "PNG-cICP" || PNG_IMAGE.contains(&tag),
        "EXIF" => group1 == "IFD0" && TIFF_IMAGE.contains(&tag),
        "PDF" => {
            matches!(
                tag,
                "PDFVersion"
                    | "Linearized"
                    | "PageCount"
                    | "MediaBox"
                    | "Encryption"
                    | "UserAccess"
            ) || tag.starts_with("EmbeddedImage")
        }
        _ => false,
    }
}

fn metadata_info(
    file_path: &str,
    entry: serde_json::Map<String, serde_json::Value>,
) -> Result<MetadataInfo, String> {
    let path = Path::new(file_path);
    let file_size = std::fs::metadata(path)
        .map_err(|e| format!("Failed to read file metadata: {}", e))?
        .len();
    let mut metadata = HashMap::new();
    let mut removable = Vec::new();
    for (key, value) in entry {
        let formatted = match value {
            serde_json::Value::String(s) => s,
            serde_json::Value::Number(n) => n.to_string(),
            serde_json::Value::Bool(b) => b.to_string(),
            serde_json::Value::Array(arr) => arr
                .iter()
                .filter_map(|v| v.as_str())
                .collect::<Vec<_>>()
                .join(", "),
            _ => continue,
        };
        let mut parts = key.rsplitn(3, ':');
        let tag = parts.next().unwrap_or_default().to_string();
        let groups: Vec<&str> = parts.collect();
        let (group0, group1) = match groups.as_slice() {
            [group1, group0] => (*group0, *group1),
            [group0] => (*group0, *group0),
            _ => ("", ""),
        };
        // The same tag can sit in several groups; the value shown is the first one the
        // cleaning would remove, not a structural copy such as a zeroed QuickTime date.
        if !is_structural(group0, group1, &tag, &formatted) && !removable.contains(&tag) {
            removable.push(tag.clone());
            metadata.insert(tag, formatted);
        } else {
            metadata.entry(tag).or_insert(formatted);
        }
    }
    Ok(MetadataInfo {
        file_path: file_path.to_string(),
        file_name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string(),
        file_size,
        metadata,
        removable,
    })
}

impl ExifToolWrapper {
    pub fn new(app_handle: &tauri::AppHandle) -> Result<Self, String> {
        let resource_path = app_handle
            .path()
            .resource_dir()
            .map_err(|e| format!("Failed to get resource dir: {}", e))?;

        let (exiftool_path, qpdf_path) = binary_paths(&resource_path.join("binaries"))?;

        if !exiftool_path.exists() {
            return Err(format!(
                "ExifTool binary not found at: {}",
                exiftool_path.display()
            ));
        }

        if !qpdf_path.exists() {
            return Err(format!("QPDF binary not found at: {}", qpdf_path.display()));
        }

        Ok(Self {
            exiftool_path,
            qpdf_path,
        })
    }

    // Perl reads its Windows command line in the ANSI code page, which loses the
    // characters of many file names, so there the arguments go through stdin as UTF-8.
    fn exiftool(&self, args: &[String]) -> Result<Output, String> {
        let fail = |e: std::io::Error| format!("Failed to execute exiftool: {}", e);
        if cfg!(not(target_os = "windows")) {
            return tool(&self.exiftool_path).args(args).output().map_err(fail);
        }
        let mut child = tool(&self.exiftool_path)
            .args(["-charset", "filename=utf8", "-@", "-"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(fail)?;
        if let Some(mut stdin) = child.stdin.take() {
            use std::io::Write;
            stdin.write_all(args.join("\n").as_bytes()).map_err(fail)?;
        }
        child.wait_with_output().map_err(fail)
    }

    fn run_exiftool(&self, args: &[String]) -> Result<(), String> {
        let output = self.exiftool(args)?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).to_string())
        }
    }

    // QPDF exits with 3 when it succeeds with warnings, which damaged but readable
    // PDFs often trigger.
    fn qpdf(&self, args: &[std::ffi::OsString]) -> Result<(), String> {
        let result = tool(&self.qpdf_path)
            .args(args)
            .output()
            .map_err(|e| format!("Failed to execute qpdf: {}", e))?;
        let stderr = String::from_utf8_lossy(&result.stderr);
        match result.status.code() {
            Some(0) | Some(3) => Ok(()),
            _ if stderr.contains("legacy provider") => Err(OLD_ENCRYPTION.to_string()),
            _ => Err(format!("QPDF could not rewrite the PDF: {}", stderr)),
        }
    }

    // ExifTool only edits the document's own metadata. A photo placed in a PDF is
    // usually copied in as is, EXIF and GPS included, and so is the XMP attached to a
    // page or an image. The color profile stays because viewers may use it to draw
    // the photo.
    fn clean_embedded(&self, pdf: &Path, dir: &Path) -> Result<Option<PathBuf>, String> {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let dump = dir.join("pdf.json");
        let mut prefix = std::ffi::OsString::from("--json-stream-prefix=");
        prefix.push(dir.join("stream"));
        self.qpdf(&[
            "--json-output".into(),
            "--json-stream-data=file".into(),
            prefix,
            "--decode-level=none".into(),
            pdf.into(),
            dump.clone().into(),
        ])?;

        let mut json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&dump).map_err(|e| e.to_string())?)
                .map_err(|e| format!("QPDF wrote unreadable JSON: {}", e))?;
        let mut changed = serde_json::Map::new();
        let mut photos = Vec::new();
        if let Some(objects) = json.pointer_mut("/qpdf/1").and_then(|o| o.as_object_mut()) {
            for (key, object) in objects.iter_mut() {
                let dict_path = if object.get("stream").is_some() {
                    "/stream/dict"
                } else {
                    "/value"
                };
                let Some(dict) = object
                    .pointer_mut(dict_path)
                    .and_then(|d| d.as_object_mut())
                else {
                    continue;
                };
                let mut edited = dict.remove("/Metadata").is_some();
                let filter = dict.get("/Filter");
                let jpeg = filter.is_some_and(|f| {
                    f == "/DCTDecode"
                        || f.as_array()
                            .is_some_and(|a| a.len() == 1 && a[0] == "/DCTDecode")
                });
                if jpeg {
                    if let Some(file) = object.pointer("/stream/datafile").and_then(|f| f.as_str())
                    {
                        let photo = PathBuf::from(format!("{}.jpg", file));
                        std::fs::rename(file, &photo).map_err(|e| e.to_string())?;
                        object["stream"]["datafile"] = photo.to_string_lossy().into();
                        photos.push(photo.to_string_lossy().to_string());
                        edited = true;
                    }
                }
                if edited {
                    if let Some(stream) = object.get_mut("stream").and_then(|s| s.as_object_mut()) {
                        if !jpeg {
                            stream.remove("datafile");
                        }
                    }
                    changed.insert(key.clone(), object.clone());
                }
            }
        }
        if changed.is_empty() {
            return Ok(None);
        }

        if !photos.is_empty() {
            let mut args: Vec<String> = [
                "-all=",
                "--ICC_Profile:all",
                "-overwrite_original",
                "-q",
                "-q",
            ]
            .iter()
            .map(|arg| arg.to_string())
            .collect();
            args.extend(photos);
            // A photo ExifTool cannot parse is left as it is; the check after the
            // rewrite decides whether the PDF is clean.
            self.exiftool(&args)?;
        }

        let header = json.pointer("/qpdf/0").cloned().unwrap_or_default();
        let update = dir.join("update.json");
        let body = serde_json::json!({ "qpdf": [header, changed] });
        std::fs::write(&update, body.to_string()).map_err(|e| e.to_string())?;
        Ok(Some(update))
    }

    fn rewrite_pdf(
        &self,
        input: &Path,
        output: &Path,
        update: Option<&Path>,
    ) -> Result<(), String> {
        let mut args: Vec<std::ffi::OsString> = vec![input.into(), output.into()];
        if let Some(update) = update {
            let mut arg = std::ffi::OsString::from("--update-from-json=");
            arg.push(update);
            args.push(arg);
        }
        self.qpdf(&args)
    }

    fn check_clean(&self, pdf: &Path) -> Result<(), String> {
        let left = self
            .read_many(&[pdf.to_string_lossy().to_string()])
            .remove(0)?
            .removable;
        if left.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "MetadataZero could not remove {} from this PDF. The file was not changed.",
                left.join(", ")
            ))
        }
    }

    // ExifTool edits a PDF by appending an update, so the removed values stay in the
    // file and can be restored. QPDF rewrites only the objects still in use, which
    // drops them for good. Every step writes to temporary files next to the original
    // so a failure never leaves a half-cleaned file behind, and a PDF that still
    // holds something removable is never saved.
    fn write_cleaned(
        &self,
        file_path: &str,
        mut args: Vec<String>,
        overwrite: bool,
        preserve_modification_date: bool,
    ) -> Result<String, String> {
        let path = Path::new(file_path);
        let output_path = output_path_for(path, overwrite)?;

        if !overwrite && Path::new(&output_path).exists() {
            let name = Path::new(&output_path)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy();
            return Err(format!(
                "{} already exists. Move or rename it, then try again.",
                name
            ));
        }

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

        let modified = std::fs::metadata(path).and_then(|m| m.modified()).ok();
        let edited = sibling(path, "edited");
        let rewritten = sibling(path, "rewritten");
        let streams = edited.with_extension("streams");
        let _ = std::fs::remove_file(&edited);
        let _ = std::fs::remove_file(&rewritten);
        let _ = std::fs::remove_dir_all(&streams);

        args.push("-o".to_string());
        args.push(edited.to_string_lossy().to_string());
        args.push(file_path.to_string());

        let result = self
            .run_exiftool(&args)
            .and_then(|_| self.clean_embedded(&edited, &streams))
            .and_then(|update| self.rewrite_pdf(&edited, &rewritten, update.as_deref()))
            .and_then(|_| self.check_clean(&rewritten))
            .and_then(|_| copy_permissions(path, &rewritten))
            .and_then(|_| std::fs::rename(&rewritten, &output_path).map_err(|e| e.to_string()));

        let _ = std::fs::remove_file(&edited);
        let _ = std::fs::remove_file(&rewritten);
        let _ = std::fs::remove_dir_all(&streams);
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

    fn read_entries(
        &self,
        file_paths: &[String],
        embedded: bool,
    ) -> Result<(Vec<serde_json::Map<String, serde_json::Value>>, String), String> {
        if file_paths.is_empty() {
            return Ok((Vec::new(), String::new()));
        }
        let args: Vec<String> = ["-json", "-a", "-s", "-G0:1"]
            .iter()
            .map(|arg| arg.to_string())
            .chain(embedded.then(|| "-ee".to_string()))
            .chain(file_paths.iter().cloned())
            .collect();
        let output = self.exiftool(&args)?;
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Ok((
            serde_json::from_slice(&output.stdout).unwrap_or_default(),
            stderr,
        ))
    }

    // One ExifTool run for many files: starting the packed binary costs far more than
    // reading a file. PDFs get a second run with -ee, which reads the photos placed in
    // them; on videos it would list every frame of a GPS track. Results come back in
    // the order of `file_paths`.
    pub fn read_many(&self, file_paths: &[String]) -> Vec<Result<MetadataInfo, String>> {
        let (pdfs, others): (Vec<String>, Vec<String>) = file_paths
            .iter()
            .cloned()
            .partition(|path| is_pdf(Path::new(path)));
        let runs = self
            .read_entries(&others, false)
            .and_then(|a| self.read_entries(&pdfs, true).map(|b| (a, b)));
        let ((mut entries, stderr_others), (pdf_entries, stderr_pdfs)) = match runs {
            Ok(runs) => runs,
            Err(message) => return file_paths.iter().map(|_| Err(message.clone())).collect(),
        };
        entries.extend(pdf_entries);

        let normalize = |path: &str| path.replace('\\', "/");
        let mut by_path: HashMap<String, serde_json::Map<String, serde_json::Value>> = entries
            .into_iter()
            .filter_map(|entry| {
                let source = entry.get("SourceFile")?.as_str()?.to_string();
                Some((normalize(&source), entry))
            })
            .collect();

        file_paths
            .iter()
            .map(|file_path| {
                let stderr = if is_pdf(Path::new(file_path)) {
                    &stderr_pdfs
                } else {
                    &stderr_others
                };
                let entry = by_path.remove(&normalize(file_path)).ok_or_else(|| {
                    if stderr.is_empty() {
                        "ExifTool could not read this file".to_string()
                    } else {
                        format!("ExifTool error: {}", stderr)
                    }
                })?;
                if let Some(error) = entry.get("ExifTool:Error").and_then(|e| e.as_str()) {
                    return Err(format!("ExifTool error: {}", error));
                }
                metadata_info(file_path, entry)
            })
            .collect()
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
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "Camille Durand";

    fn wrapper() -> ExifToolWrapper {
        let binaries = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
        let (exiftool_path, qpdf_path) = binary_paths(&binaries).unwrap();
        ExifToolWrapper {
            exiftool_path,
            qpdf_path,
        }
    }

    fn write_pdf(path: &Path) {
        write_objects(
            path,
            &[
                "<< /Type /Catalog /Pages 2 0 R >>".into(),
                "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 200 200] >>".into(),
                "<< /Type /Page /Parent 2 0 R >>".into(),
                format!("<< /Author ({}) /Title (Lease agreement) >>", SECRET).into(),
            ],
        );
    }

    fn stream(dict: &str, data: &[u8]) -> Vec<u8> {
        let mut object = format!("<< {} /Length {} >>\nstream\n", dict, data.len()).into_bytes();
        object.extend(data);
        object.extend(b"\nendstream");
        object
    }

    const DRAW_PHOTO: &[u8] = b"q 64 0 0 64 0 0 cm /Im0 Do Q";

    // The photo goes in byte for byte, as most PDF writers do, with XMP on the page
    // and on its content stream.
    fn write_pdf_with_photo(path: &Path) {
        let photo =
            std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/photo.jpg"))
                .unwrap();
        let xmp = format!("<x:xmpmeta xmlns:x='adobe:ns:meta/'>{}</x:xmpmeta>", SECRET);
        write_objects(
            path,
            &[
                "<< /Type /Catalog /Pages 2 0 R >>".into(),
                "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".into(),
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 64 64] /Metadata 6 0 R /Resources << /XObject << /Im0 5 0 R >> >> /Contents 7 0 R >>".into(),
                b"<< /Title (Report) >>".to_vec(),
                stream(
                    "/Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode",
                    &photo,
                ),
                stream("/Type /Metadata /Subtype /XML", xmp.as_bytes()),
                stream("/Metadata 6 0 R", DRAW_PHOTO),
            ],
        );
    }

    fn write_objects(path: &Path, objects: &[Vec<u8>]) {
        let mut pdf = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (i, body) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.extend(format!("{} 0 obj\n", i + 1).as_bytes());
            pdf.extend(body);
            pdf.extend(b"\nendobj\n");
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
            .read_many(&[path.to_string_lossy().to_string()])
            .remove(0)
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

    #[test]
    fn many_files_are_read_in_one_run_in_order() {
        let dir = scratch("read-many");
        let photo = fixture("photo.jpg", &dir);
        let video = fixture("video.mp4", &dir);
        let missing = dir.join("missing.jpg");
        let paths: Vec<String> = [&video, &missing, &photo]
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect();

        let results = wrapper().read_many(&paths);

        assert_eq!(results.len(), 3);
        assert_eq!(results[0].as_ref().unwrap().file_name, "video.mp4");
        assert!(results[1].is_err());
        assert_eq!(results[2].as_ref().unwrap().file_name, "photo.jpg");
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

    fn removable(path: &Path) -> Vec<String> {
        wrapper()
            .read_many(&[path.to_string_lossy().to_string()])
            .remove(0)
            .unwrap()
            .removable
    }

    #[test]
    fn a_cleaned_file_has_nothing_left_to_remove() {
        for name in [
            "photo.jpg",
            "photo.png",
            "photo.tiff",
            "photo.heic",
            "video.mp4",
        ] {
            let dir = scratch(&format!("left-{}", name));
            let original = fixture(name, &dir);
            assert!(
                removable(&original).contains(&"Artist".to_string()),
                "{}",
                name
            );
            let result = wrapper()
                .clean_metadata(original.to_str().unwrap(), false, false, false, false)
                .unwrap();
            assert!(result.success, "{}", result.message);
            let left = removable(Path::new(&result.output_path));
            assert!(left.is_empty(), "{} still counts {:?}", name, left);
        }
        let dir = scratch("left-pdf");
        let original = dir.join("lease.pdf");
        write_pdf(&original);
        assert!(removable(&original).contains(&"Author".to_string()));
        let result = wrapper()
            .clean_metadata(original.to_str().unwrap(), false, false, false, false)
            .unwrap();
        assert!(result.success, "{}", result.message);
        let left = removable(Path::new(&result.output_path));
        assert!(left.is_empty(), "pdf still counts {:?}", left);
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

    #[test]
    fn photos_placed_in_a_pdf_are_shown_and_cleaned() {
        let dir = scratch("pdf-photo");
        let original = dir.join("relevé 写真.pdf");
        write_pdf_with_photo(&original);
        let before = removable(&original);
        for key in ["Model", "GPSLatitude", "DateTimeOriginal", "Artist"] {
            assert!(
                before.contains(&key.to_string()),
                "{} not shown: {:?}",
                key,
                before
            );
        }

        let result = wrapper()
            .clean_metadata(original.to_str().unwrap(), false, false, false, false)
            .unwrap();

        assert!(result.success, "{}", result.message);
        let copy = Path::new(&result.output_path);
        assert!(removable(copy).is_empty(), "left {:?}", removable(copy));
        assert!(!contains_secret(copy));
        let bytes = std::fs::read(copy).unwrap();
        assert!(!bytes.windows(6).any(|w| w == b"iPhone"));
        assert_eq!(
            fields(copy).get("EmbeddedImageWidth").map(String::as_str),
            Some("64")
        );
        let pages = Command::new(&wrapper().qpdf_path)
            .args(["--show-pages", "--with-images"])
            .arg(copy)
            .output()
            .unwrap();
        let pages = String::from_utf8_lossy(&pages.stdout);
        assert!(pages.contains("/Im0"), "{}", pages);
        let content = pages
            .lines()
            .skip_while(|line| !line.contains("content:"))
            .nth(1)
            .and_then(|line| line.trim().split(' ').next())
            .unwrap()
            .to_string();
        let drawn = Command::new(&wrapper().qpdf_path)
            .arg(format!("--show-object={}", content))
            .arg("--filtered-stream-data")
            .arg(copy)
            .output()
            .unwrap();
        assert_eq!(drawn.stdout, DRAW_PHOTO);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2);
    }

    // The macOS QPDF build cannot decrypt RC4 until upstream ships the OpenSSL
    // legacy provider. When it can, this test checks the cleaning instead.
    #[test]
    fn rc4_pdf_is_cleaned_or_left_untouched_with_a_clear_message() {
        let dir = scratch("rc4");
        let original = fixture("rc4.pdf", &dir);
        let before = std::fs::read(&original).unwrap();
        assert!(removable(&original).contains(&"Author".to_string()));

        let result = wrapper()
            .clean_metadata(original.to_str().unwrap(), false, false, false, false)
            .unwrap();

        if result.success {
            assert!(removable(Path::new(&result.output_path)).is_empty());
        } else {
            assert_eq!(result.message, OLD_ENCRYPTION);
            assert_eq!(std::fs::read(&original).unwrap(), before);
            assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        }
    }
}
