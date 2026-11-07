mod commands;
mod exiftool;

use exiftool::ExifToolWrapper;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
pub struct PendingFiles(pub Mutex<Vec<String>>);

fn queue_files(app: &AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    if let Ok(mut pending) = app.state::<PendingFiles>().0.lock() {
        pending.extend(paths);
    }
    let _ = app.emit("open-files", ());
}

fn paths_from_args(args: &[String], cwd: &Path) -> Vec<String> {
    args.iter()
        .skip(1)
        .map(|arg| cwd.join(arg))
        .filter(|path| path.exists())
        .map(|path| path.to_string_lossy().to_string())
        .collect()
}

// The default size is taller than the space a 768 pixel screen leaves above the
// taskbar, which would hide the clean button at the bottom of the window.
fn fit_to_screen(window: &tauri::WebviewWindow) {
    let (Ok(Some(monitor)), Ok(outer), Ok(inner)) =
        (window.current_monitor(), window.outer_size(), window.inner_size())
    else {
        return;
    };
    let area = monitor.work_area();
    if outer.width <= area.size.width && outer.height <= area.size.height {
        return;
    }
    let width = outer.width.min(area.size.width);
    let height = outer.height.min(area.size.height);
    let _ = window.set_size(tauri::PhysicalSize::new(
        width - (outer.width - inner.width),
        height - (outer.height - inner.height),
    ));
    let _ = window.set_position(tauri::PhysicalPosition::new(
        area.position.x + ((area.size.width - width) / 2) as i32,
        area.position.y + ((area.size.height - height) / 2) as i32,
    ));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    #[cfg(not(target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
        queue_files(app, paths_from_args(&args, Path::new(&cwd)));
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }));

    builder
        .manage(PendingFiles::default())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let exiftool = ExifToolWrapper::new(&app.handle())?;

            app.manage(exiftool);

            let args: Vec<String> = std::env::args().collect();
            let cwd = std::env::current_dir().unwrap_or_default();
            queue_files(app.handle(), paths_from_args(&args, &cwd));

            if let Some(window) = app.get_webview_window("main") {
                fit_to_screen(&window);
            }

            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{MenuBuilder, MenuItem, PredefinedMenuItem, Submenu};

                let settings_item = MenuItem::with_id(app, "settings", "Settings...", true, Some("Cmd+,"))?;

                let app_menu = Submenu::with_items(
                    app,
                    "MetadataZero",
                    true,
                    &[
                        &PredefinedMenuItem::about(app, None, None)?,
                        &PredefinedMenuItem::separator(app)?,
                        &settings_item,
                        &PredefinedMenuItem::separator(app)?,
                        &PredefinedMenuItem::hide(app, None)?,
                        &PredefinedMenuItem::hide_others(app, None)?,
                        &PredefinedMenuItem::show_all(app, None)?,
                        &PredefinedMenuItem::separator(app)?,
                        &PredefinedMenuItem::quit(app, None)?,
                    ],
                )?;

                let edit_menu = Submenu::with_items(
                    app,
                    "Edit",
                    true,
                    &[
                        &PredefinedMenuItem::undo(app, None)?,
                        &PredefinedMenuItem::redo(app, None)?,
                        &PredefinedMenuItem::separator(app)?,
                        &PredefinedMenuItem::cut(app, None)?,
                        &PredefinedMenuItem::copy(app, None)?,
                        &PredefinedMenuItem::paste(app, None)?,
                        &PredefinedMenuItem::select_all(app, None)?,
                    ],
                )?;

                let window_menu = Submenu::with_items(
                    app,
                    "Window",
                    true,
                    &[
                        &PredefinedMenuItem::minimize(app, None)?,
                        &PredefinedMenuItem::maximize(app, None)?,
                        &PredefinedMenuItem::separator(app)?,
                        &PredefinedMenuItem::close_window(app, None)?,
                    ],
                )?;

                let menu = MenuBuilder::new(app)
                    .item(&app_menu)
                    .item(&edit_menu)
                    .item(&window_menu)
                    .build()?;

                app.set_menu(menu)?;

                app.on_menu_event(move |app, event| {
                    if event.id() == "settings" {
                        let _ = app.emit("open-settings", ());
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::exiftool_version,
            commands::take_pending_files,
            commands::read_files_metadata,
            commands::clean_file_metadata,
            commands::expand_paths,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                let paths = urls
                    .into_iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .filter_map(|path| path.to_str().map(String::from))
                    .collect();
                queue_files(_app, paths);
            }
        });
}
