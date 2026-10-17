mod menu;

use tauri_plugin_sql::{Migration, MigrationKind};
use tauri_plugin_window_state::StateFlags;

/// Database migrations. Each file must be safe to re-run (IF NOT EXISTS) so a
/// library copied from the old server build can be adopted as-is.
fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "init",
            sql: include_str!("../migrations/0001_init.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "settings and art palettes",
            sql: include_str!("../migrations/0002_settings.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "fan collection and wishlist",
            sql: include_str!("../migrations/0003_fan_items.sql"),
            kind: MigrationKind::Up,
        },
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:library.db", migrations())
                .build(),
        )
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        // Remember size and position. VISIBLE is excluded on purpose: closing
        // the window hides it, and restoring "hidden" would launch an invisible app.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        .menu(|handle| menu::build(handle))
        .on_menu_event(|app, event| menu::on_event(app, event.id().as_ref()))
        .build(tauri::generate_context!())
        .expect("error while building Bandcamp Player");

    app.run(|app, event| {
        // Dock icon clicked while the window is hidden (closed) or minimized.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            menu::show_main(app);
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (app, event);
    });
}
