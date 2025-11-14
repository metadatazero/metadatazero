mod commands;
mod exiftool;

use commands::AppState;
use exiftool::ExifToolWrapper;
use std::sync::{Arc, Mutex};
use tauri::menu::MenuItem;
use tauri::{Emitter, Manager};

#[cfg(not(target_os = "macos"))]
use tauri::menu::Menu;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let exiftool = ExifToolWrapper::new(&app.handle())?;

            app.manage(AppState {
                exiftool: Arc::new(Mutex::new(exiftool)),
            });

            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{MenuBuilder, PredefinedMenuItem, Submenu};

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

            #[cfg(not(target_os = "macos"))]
            {
                let settings_item = MenuItem::with_id(app, "settings", "Settings...", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&settings_item])?;

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
            commands::read_file_metadata,
            commands::clean_file_metadata,
            commands::clean_file_selective,
            commands::clean_multiple_files,
            commands::read_multiple_metadata,
            commands::expand_paths,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
