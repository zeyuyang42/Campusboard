//! The mini player window (label `mini`, page `mini.html`). It has no audio and no database:
//! it talks to the main window's player over events (web/src/mini/, web/src/player/miniBridge.ts)
//! and its capability (capabilities/mini.json) allows little more than that. Created on first
//! use, then only hidden and shown, so the window-state plugin restores its size and position
//! when it is created and saves them at exit.

use tauri::window::Color;
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "mini";
/// Compact strip; web/src/mini/window.ts has the same sizes and the square-art one.
const SIZE: (f64, f64) = (340.0, 100.0);
const MIN_SIZE: (f64, f64) = (260.0, 84.0);
const MAX_SIZE: (f64, f64) = (560.0, 680.0);

#[derive(Debug, PartialEq, Eq)]
enum Toggle {
    Create,
    Show,
    Hide,
}

/// What Window > Mini Player does: hide a visible, unminimized mini window, otherwise bring it up.
fn toggle_action(exists: bool, visible: bool, minimized: bool) -> Toggle {
    match (exists, visible && !minimized) {
        (false, _) => Toggle::Create,
        (true, true) => Toggle::Hide,
        (true, false) => Toggle::Show,
    }
}

pub fn toggle<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let existing = app.get_webview_window(LABEL);
    let action = match &existing {
        Some(w) => toggle_action(true, w.is_visible().unwrap_or(false), w.is_minimized().unwrap_or(false)),
        None => toggle_action(false, false, false),
    };
    match (action, existing) {
        (Toggle::Hide, Some(w)) => w.hide(),
        (Toggle::Show, Some(w)) => {
            if w.is_minimized().unwrap_or(false) {
                w.unminimize()?;
            }
            w.show()?;
            w.set_focus()
        }
        _ => {
            // Built hidden: the window-state plugin moves it to its saved place first.
            let w = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("mini.html".into()))
                .title("Mini Player")
                .inner_size(SIZE.0, SIZE.1)
                .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
                .max_inner_size(MAX_SIZE.0, MAX_SIZE.1)
                .resizable(true)
                .maximizable(false)
                .minimizable(false)
                .decorations(false)
                .shadow(true)
                .always_on_top(true)
                .visible_on_all_workspaces(false)
                .background_color(Color(0x23, 0x26, 0x2D, 0xFF))
                .visible(false)
                .build()?;
            w.show()?;
            w.set_focus()
        }
    }
}

/// The dock bar's mini player button (main window only, see capabilities/default.json).
#[tauri::command]
pub fn toggle_mini_player(app: AppHandle) -> Result<(), String> {
    toggle(&app).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toggles_like_a_window_menu_item() {
        assert_eq!(toggle_action(false, false, false), Toggle::Create);
        assert_eq!(toggle_action(true, true, false), Toggle::Hide);
        assert_eq!(toggle_action(true, false, false), Toggle::Show);
        // Minimized counts as not showing: bring it back rather than hiding it.
        assert_eq!(toggle_action(true, true, true), Toggle::Show);
    }

    #[test]
    fn sizes_are_in_bounds() {
        assert!(MIN_SIZE.0 <= SIZE.0 && SIZE.0 <= MAX_SIZE.0);
        assert!(MIN_SIZE.1 <= SIZE.1 && SIZE.1 <= MAX_SIZE.1);
        // The square-art layout (300 x 404 in window.ts) must fit too.
        assert!(MIN_SIZE.0 <= 300.0 && 404.0 <= MAX_SIZE.1);
    }
}
