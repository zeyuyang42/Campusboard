//! Native macOS menu bar. Custom items run `window.__bcMenu(id)` in the main webview
//! (see `dispatch`); the web app maps ids to actions in `web/src/lib/appMenu.ts`.

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, Runtime};

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
            &item(app, "close-window", "Close Window", Some("CmdOrCtrl+W"))?,
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
            &item(app, "mini-player", "Mini Player", Some("CmdOrCtrl+Shift+M"))?,
            &sep()?,
            &item(app, "close-window:window-menu", "Close Window", None)?,
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

/// Playback items act on the player wherever the user is (the mini window included),
/// so they don't bring the main window forward.
const CONTROLS: &[&str] = &["play-pause", "next", "previous", "volume-up", "volume-down", "shuffle", "repeat"];

/// What a custom menu item (app menu or menu-bar icon) does.
#[derive(Debug, PartialEq, Eq)]
enum Route {
    /// Toggle the mini window.
    Mini,
    /// Close the focused window.
    Close,
    /// Bring the main window forward and nothing else (the menu-bar icon's Show Window).
    ShowMain,
    /// Hand the id to the player without raising any window.
    Control,
    /// Bring the main window forward, then hand it the id.
    Raise,
    /// The menu-bar icon's disabled track row.
    Ignore,
}

fn route(id: &str) -> Route {
    match id {
        "mini-player" => Route::Mini,
        crate::tray::SHOW_ID => Route::ShowMain,
        crate::tray::TRACK_ID => Route::Ignore,
        _ if id.starts_with("close-window") => Route::Close,
        _ if CONTROLS.contains(&id) => Route::Control,
        _ => Route::Raise,
    }
}

/// Custom items bring the (possibly hidden) main window forward and hand the id to the
/// web app. Predefined items never reach this handler. Exceptions: Mini Player toggles
/// the mini window, Close Window closes the focused window, and Controls items (also on
/// the menu-bar icon, whose events arrive here too) leave the windows as they are.
pub fn on_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match route(id) {
        Route::Mini => {
            if let Err(e) = crate::mini::toggle(app, true) {
                eprintln!("mini player: {e}");
            }
        }
        Route::Close => close_window(app, focused_label(app).as_deref()),
        Route::ShowMain => show_main(app),
        Route::Control => dispatch(app, id),
        Route::Raise => {
            show_main(app);
            dispatch(app, id);
        }
        Route::Ignore => {}
    }
}

/// Run a menu action in the main window. Evaluated in that webview rather than sent as an
/// event: the mini window may listen to and emit any event name (event permissions have
/// no scope), so it must not be able to read or forge menu actions that way.
fn dispatch<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if let (Some(w), Ok(arg)) = (app.get_webview_window("main"), serde_json::to_string(id)) {
        let _ = w.eval(format!("window.__bcMenu && window.__bcMenu({arg})"));
    }
}

fn focused_label<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    app.webview_windows()
        .into_iter()
        .find(|(_, w)| w.is_focused().unwrap_or(false))
        .map(|(label, _)| label)
}

#[derive(Debug, PartialEq, Eq)]
enum CloseTarget {
    Mini,
    Main,
    Nothing,
}

/// The mini window is borderless, so AppKit's performClose: (the predefined Close Window
/// item) refuses it; Close Window is a custom item that decides here instead.
/// No focused webview window means a native panel (About, a dialog) has focus: do
/// nothing rather than hide the main window. tao gives no handle to that panel, so it
/// can't be sent performClose:; such panels close with their own button or Esc.
fn close_target(focused: Option<&str>) -> CloseTarget {
    match focused {
        Some(crate::mini::LABEL) => CloseTarget::Mini,
        Some(_) => CloseTarget::Main,
        None => CloseTarget::Nothing,
    }
}

/// Close Window (⌘W): hide the mini window when it is focused. Otherwise send the main
/// window the same close request the red button (and the old predefined item) sends,
/// which persist.ts turns into a hide after saving the play state.
pub fn close_window<R: Runtime>(app: &AppHandle<R>, focused: Option<&str>) {
    match close_target(focused) {
        CloseTarget::Mini => {
            if let Some(w) = app.get_webview_window(crate::mini::LABEL) {
                crate::mini::hide(app, &w);
            }
        }
        CloseTarget::Main => {
            if let Some(w) = app.get_webview_window("main") {
                if w.is_visible().unwrap_or(false) {
                    let _ = w.close();
                }
            }
        }
        CloseTarget::Nothing => {}
    }
}

/// Selftest helper (debug builds only): run a menu item through the same handler a click
/// uses. Close Window takes the focused label from the caller, since a selftest window
/// started from a terminal may never get focus.
#[tauri::command]
pub fn selftest_menu(app: AppHandle, id: String, focused: Option<String>) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Err("selftest only".into());
    }
    if id.starts_with("close-window") {
        close_window(&app, focused.as_deref());
    } else {
        on_event(&app, &id);
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn close_window_hides_the_mini_window_only_when_it_is_focused() {
        assert_eq!(close_target(Some("mini")), CloseTarget::Mini);
        assert_eq!(close_target(Some("main")), CloseTarget::Main);
        assert_eq!(close_target(None), CloseTarget::Nothing);
    }

    #[test]
    fn controls_do_not_raise_the_main_window() {
        for id in ["play-pause", "next", "previous", "volume-up", "volume-down", "shuffle", "repeat"] {
            assert!(CONTROLS.contains(&id));
        }
        assert!(!CONTROLS.contains(&"now-playing") && !CONTROLS.contains(&"settings"));
    }

    #[test]
    fn routes_menu_ids() {
        assert_eq!(route("mini-player"), Route::Mini);
        assert_eq!(route("close-window"), Route::Close);
        assert_eq!(route("close-window:window-menu"), Route::Close);
        assert_eq!(route("settings"), Route::Raise);
        assert_eq!(route("nav:library"), Route::Raise);
        assert_eq!(route("volume-up"), Route::Control);
    }

    #[test]
    fn menu_bar_items_control_playback_without_raising_the_window() {
        for id in ["play-pause", "next", "previous"] {
            assert_eq!(route(id), Route::Control);
        }
        assert_eq!(route(crate::tray::SHOW_ID), Route::ShowMain);
        assert_eq!(route(crate::tray::TRACK_ID), Route::Ignore);
    }
}
