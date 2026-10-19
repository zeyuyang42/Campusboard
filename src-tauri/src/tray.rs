//! Optional menu-bar (status bar) icon, off by default. The main window turns it on or off
//! and passes the current track title through `set_menu_bar`. Its items share ids with the
//! Controls menu, so a click goes through `menu::on_event` like any menu item and ends up in
//! the player store via `window.__bcMenu`; there is no separate channel.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Runtime};

const TRAY_ID: &str = "menu-bar";
/// The disabled first row showing the current track. It never fires.
pub const TRACK_ID: &str = "tray:track";
/// Show window. Handled in `menu::route`.
pub const SHOW_ID: &str = "tray:show";
const MAX_LABEL: usize = 48;

/// The first row's text: the track title, shortened to fit a menu.
fn track_label(track: Option<&str>) -> String {
    let t = track.map(str::trim).filter(|t| !t.is_empty());
    match t {
        None => "Nothing playing".into(),
        Some(t) if t.chars().count() > MAX_LABEL => {
            let cut: String = t.chars().take(MAX_LABEL - 1).collect();
            format!("{}…", cut.trim_end())
        }
        Some(t) => t.to_string(),
    }
}

fn build_menu<R: Runtime>(app: &AppHandle<R>, track: Option<&str>) -> tauri::Result<Menu<R>> {
    Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, TRACK_ID, track_label(track), false, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "play-pause", "Play/Pause", true, None::<&str>)?,
            &MenuItem::with_id(app, "next", "Next", true, None::<&str>)?,
            &MenuItem::with_id(app, "previous", "Previous", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, SHOW_ID, "Show Window", true, None::<&str>)?,
            // The same terminate: as Cmd+Q in the app menu.
            &PredefinedMenuItem::quit(app, Some("Quit Bandcamp Player"))?,
        ],
    )
}

fn apply<R: Runtime>(app: &AppHandle<R>, enabled: bool, track: Option<&str>) -> tauri::Result<()> {
    if !enabled {
        app.remove_tray_by_id(TRAY_ID);
        return Ok(());
    }
    let menu = build_menu(app, track)?;
    match app.tray_by_id(TRAY_ID) {
        // Rebuilt on each call: calls come only on a track change or the toggle.
        Some(tray) => tray.set_menu(Some(menu)),
        None => TrayIconBuilder::with_id(TRAY_ID)
            .icon(tauri::include_image!("icons/tray.png"))
            .icon_as_template(true)
            .tooltip("Bandcamp Player")
            .menu(&menu)
            .build(app)
            .map(|_| ()),
    }
}

/// Create, update or remove the menu-bar icon. Sync, so it runs on the main thread, which
/// AppKit requires for status items. Called by web/src/lib/menuBar.ts.
#[tauri::command]
pub fn set_menu_bar(app: AppHandle, enabled: bool, track: Option<String>) -> Result<(), String> {
    apply(&app, enabled, track.as_deref()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn track_label_falls_back_and_shortens() {
        assert_eq!(track_label(None), "Nothing playing");
        assert_eq!(track_label(Some("  ")), "Nothing playing");
        assert_eq!(track_label(Some("Let Me Do One More")), "Let Me Do One More");
        let long = "x".repeat(80);
        let label = track_label(Some(&long));
        assert_eq!(label.chars().count(), MAX_LABEL);
        assert!(label.ends_with('…'));
    }
}
