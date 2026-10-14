//! Native macOS menu bar. Custom items emit a `menu` event with their id; the
//! web app maps ids to actions in `web/src/lib/appMenu.ts`.

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Runtime};

fn item<R: Runtime>(app: &AppHandle<R>, id: &str, label: &str, accel: Option<&str>) -> tauri::Result<MenuItem<R>> {
    MenuItem::with_id(app, id, label, true, accel)
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let about = AboutMetadata {
        name: Some("Bandcamp Player".into()),
        version: Some(app.package_info().version.to_string()),
        copyright: Some("Personal use. Buy the music you keep coming back to.".into()),
        ..Default::default()
    };
    let sep = || PredefinedMenuItem::separator(app);

    let app_menu = Submenu::with_items(
        app,
        "Bandcamp Player",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About Bandcamp Player"), Some(about))?,
            &sep()?,
            &item(app, "settings", "Settings…", Some("CmdOrCtrl+,"))?,
            &sep()?,
            &PredefinedMenuItem::services(app, None)?,
            &sep()?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &sep()?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &item(app, "import", "Import from Link…", Some("CmdOrCtrl+I"))?,
            &item(app, "new-playlist", "New Playlist", Some("CmdOrCtrl+N"))?,
            &sep()?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &sep()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
            &sep()?,
            &item(app, "find", "Find", Some("CmdOrCtrl+F"))?,
        ],
    )?;

    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &item(app, "nav:library", "Library", Some("CmdOrCtrl+1"))?,
            &item(app, "nav:search", "Search", Some("CmdOrCtrl+2"))?,
            &item(app, "nav:import", "Import", Some("CmdOrCtrl+3"))?,
            &item(app, "nav:playlists", "Playlists", Some("CmdOrCtrl+4"))?,
            &sep()?,
            &item(app, "back", "Back", Some("CmdOrCtrl+["))?,
            &item(app, "forward", "Forward", Some("CmdOrCtrl+]"))?,
            &sep()?,
            &item(app, "now-playing", "Now Playing", Some("CmdOrCtrl+Shift+N"))?,
            &item(app, "queue", "Queue", Some("CmdOrCtrl+Shift+Q"))?,
            &sep()?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;

    let controls = Submenu::with_items(
        app,
        "Controls",
        true,
        &[
            &item(app, "play-pause", "Play/Pause", Some("CmdOrCtrl+P"))?,
            &item(app, "next", "Next", Some("CmdOrCtrl+Right"))?,
            &item(app, "previous", "Previous", Some("CmdOrCtrl+Left"))?,
            &sep()?,
            &item(app, "volume-up", "Volume Up", Some("CmdOrCtrl+Up"))?,
            &item(app, "volume-down", "Volume Down", Some("CmdOrCtrl+Down"))?,
            &sep()?,
            &item(app, "shuffle", "Shuffle", Some("CmdOrCtrl+Shift+S"))?,
            &item(app, "repeat", "Repeat", Some("CmdOrCtrl+Shift+R"))?,
        ],
    )?;

    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, Some("Zoom"))?,
            &sep()?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let help = Submenu::with_items(
        app,
        "Help",
        true,
        &[&item(app, "shortcuts", "Keyboard Shortcuts", None)?],
    )?;

    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &controls, &window, &help])
}

/// Custom items bring the (possibly hidden) main window forward and hand the
/// id to the web app. Predefined items never reach this handler.
pub fn on_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    show_main(app);
    let _ = app.emit("menu", id.to_string());
}

/// Show and focus the main window; used by menu items and Dock reopen.
pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_minimized().unwrap_or(false) {
            let _ = w.unminimize();
        }
        let _ = w.show();
        let _ = w.set_focus();
    }
}
