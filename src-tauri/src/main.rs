#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod model;
mod store;
mod hooks;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .run(tauri::generate_context!())
        .expect("error while running cowork-deck");
}
