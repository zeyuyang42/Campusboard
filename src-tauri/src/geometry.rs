//! Window size and position, saved in points (logical pixels) per window label.
//!
//! Replaces tauri-plugin-window-state, which saves physical pixels and restores them as
//! physical pixels on whatever screen the window opens on: with a Retina laptop (2x) and
//! an external display (1x) a window saved on one came back at half or double the size on
//! the other. macOS places windows in points across all screens, so a logical rect from
//! one launch means the same on the next. Debug builds keep their own file, so dev and
//! selftest runs never move or resize the installed app's windows.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{LogicalPosition, LogicalSize, Manager, Runtime, WebviewWindow};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    /// Whether this is a whole screen's frame, menu bar included: a full-screen window's
    /// frame. A zoomed window fills only the work area, so it normally never matches (it
    /// can when the menu bar and Dock both auto-hide; that frame is then just not recorded).
    fn covers(&self, screen: &Rect) -> bool {
        (self.x - screen.x).abs() < 1.0
            && (self.y - screen.y).abs() < 1.0
            && (self.w - screen.w).abs() < 1.0
            && (self.h - screen.h).abs() < 1.0
    }

    fn overlap(&self, o: &Rect) -> f64 {
        let w = (self.x + self.w).min(o.x + o.w) - self.x.max(o.x);
        let h = (self.y + self.h).min(o.y + o.h) - self.y.max(o.y);
        if w > 0.0 && h > 0.0 { w * h } else { 0.0 }
    }
}

/// How a window may be sized: its first-launch size and its bounds. `snap` lists the only
/// sizes the window comes back at (the mini player's two layouts), picked by height.
pub struct Sizing {
    pub default: (f64, f64),
    pub min: (f64, f64),
    pub max: (f64, f64),
    pub snap: &'static [(f64, f64)],
}

pub const MAIN: Sizing = Sizing {
    default: (1280.0, 820.0),
    min: (480.0, 400.0),
    max: (f64::INFINITY, f64::INFINITY),
    snap: &[],
};

/// Where a window opens. `pos` is None only when there is no screen to centre it on.
#[derive(Debug, PartialEq)]
pub struct Placement {
    pub size: (f64, f64),
    pub pos: Option<(f64, f64)>,
}

/// Fit a saved rect (or the default size) to the screens there are now. A saved window
/// stays where it was if enough of it is on a screen, moved and shrunk to fit inside that
/// screen; otherwise it is centred on `screens[0]`, the screen a new window opens on.
pub fn place(saved: Option<Rect>, screens: &[Rect], s: &Sizing) -> Placement {
    let clamp = |(w, h): (f64, f64), area: Option<&Rect>| {
        let (mut w, mut h) = (w.clamp(s.min.0, s.max.0), h.clamp(s.min.1, s.max.1));
        if let Some(a) = area {
            w = w.min(a.w).max(s.min.0.min(a.w));
            h = h.min(a.h).max(s.min.1.min(a.h));
        }
        (w, h)
    };
    // Centred here rather than by NSWindow `center`, which runs at once while tao queues
    // `set_size`: the window would be centred at its old size and then grow off-centre.
    let centred = |size: (f64, f64)| Placement {
        size,
        pos: screens.first().map(|a| (a.x + (a.w - size.0) / 2.0, a.y + (a.h - size.1) / 2.0)),
    };
    let snapped = |(w, h): (f64, f64)| -> (f64, f64) {
        match s.snap {
            [] => (w, h),
            sizes => *sizes
                .iter()
                .min_by(|a, b| (a.1 - h).abs().total_cmp(&(b.1 - h).abs()))
                .unwrap(),
        }
    };
    if let Some(r) = saved.filter(|r| r.w.is_finite() && r.h.is_finite() && r.x.is_finite() && r.y.is_finite()) {
        // The screen holding most of it; less than a 40 x 40 patch on any screen doesn't count.
        let best = screens
            .iter()
            .map(|a| (a, r.overlap(a)))
            .filter(|(_, o)| *o >= 1600.0_f64.min(r.w * r.h))
            .max_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(a, _)| a);
        let size = clamp(snapped((r.w, r.h)), best.or(screens.first()));
        return match best {
            Some(a) => Placement {
                size,
                pos: Some((
                    r.x.min(a.x + a.w - size.0).max(a.x),
                    r.y.min(a.y + a.h - size.1).max(a.y),
                )),
            },
            None => centred(size),
        };
    }
    centred(clamp(s.default, screens.first()))
}

/// A screen's usable area (without the menu bar and Dock) in points.
fn work_area(m: &tauri::Monitor) -> Rect {
    let k = m.scale_factor();
    let a = m.work_area();
    Rect {
        x: a.position.x as f64 / k,
        y: a.position.y as f64 / k,
        w: a.size.width as f64 / k,
        h: a.size.height as f64 / k,
    }
}

/// A screen's whole frame in points.
fn screen_frame(m: &tauri::Monitor) -> Rect {
    let k = m.scale_factor();
    Rect {
        x: m.position().x as f64 / k,
        y: m.position().y as f64 / k,
        w: m.size().width as f64 / k,
        h: m.size().height as f64 / k,
    }
}

pub struct Geometry {
    path: Option<PathBuf>,
    rects: Mutex<HashMap<String, Rect>>,
}

impl Geometry {
    pub fn load<R: Runtime>(app: &tauri::App<R>) -> Self {
        let name = if cfg!(debug_assertions) { "window-geometry-dev.json" } else { "window-geometry.json" };
        let path = app.path().app_data_dir().ok().map(|d| d.join(name));
        let rects = path
            .as_ref()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Geometry { path, rects: Mutex::new(rects) }
    }

    /// Note where a window is now. Ignored while it is hidden, minimized or full screen, so
    /// those never become the size it reopens at. A zoomed window counts: on macOS that is
    /// just a frame (`isZoomed` is true for any window filling the screen), kept as it is.
    /// tao stops reporting full screen as soon as `set_fullscreen(false)` is called (a close
    /// in full screen, fullscreen.rs), while the frame is still the screen's, so a frame
    /// that covers its whole screen is skipped too.
    pub fn record<R: Runtime>(&self, w: &WebviewWindow<R>) {
        let normal = w.is_visible().unwrap_or(false)
            && !w.is_minimized().unwrap_or(true)
            && !w.is_fullscreen().unwrap_or(true);
        let (Ok(scale), Ok(pos), Ok(size)) = (w.scale_factor(), w.outer_position(), w.inner_size()) else { return };
        if !normal {
            return;
        }
        let pos = pos.to_logical::<f64>(scale);
        let size = size.to_logical::<f64>(scale);
        let rect = Rect { x: pos.x, y: pos.y, w: size.width, h: size.height };
        if let Ok(Some(m)) = w.current_monitor() {
            if rect.covers(&screen_frame(&m)) {
                return;
            }
        }
        self.rects.lock().unwrap().insert(w.label().to_string(), rect);
    }

    pub fn save(&self) {
        let Some(path) = &self.path else { return };
        // Held through the write so two saves (mini hide, quit) can't interleave in the temp file.
        let rects = self.rects.lock().unwrap();
        let Ok(json) = serde_json::to_vec_pretty(&*rects) else { return };
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }

    /// Size and move a window that hasn't been shown yet.
    pub fn restore<R: Runtime>(&self, w: &WebviewWindow<R>, s: &Sizing) {
        let saved = self.rects.lock().unwrap().get(w.label()).copied();
        let mut screens: Vec<Rect> = w.available_monitors().unwrap_or_default().iter().map(work_area).collect();
        // The screen the window was created on goes first: a default-sized window is centred there.
        if let Ok(Some(cur)) = w.current_monitor() {
            let cur = work_area(&cur);
            if let Some(i) = screens.iter().position(|r| *r == cur) {
                screens.swap(0, i);
            }
        }
        let p = place(saved, &screens, s);
        // Move first: AppKit keeps a window no taller than the screen it is on, so sizing it
        // while it is still on a smaller screen would cut the height. tao queues both in order.
        if let Some((x, y)) = p.pos {
            let _ = w.set_position(LogicalPosition::new(x, y));
        }
        let _ = w.set_size(LogicalSize::new(p.size.0, p.size.1));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LAPTOP: Rect = Rect { x: 0.0, y: 37.0, w: 1512.0, h: 945.0 };
    const EXTERNAL: Rect = Rect { x: 1512.0, y: -458.0, w: 2560.0, h: 1415.0 };
    const MINI: Sizing = Sizing {
        default: (340.0, 100.0),
        min: (260.0, 84.0),
        max: (560.0, 680.0),
        snap: &[(340.0, 100.0), (300.0, 404.0)],
    };

    #[test]
    fn first_launch_uses_the_default_size_centred_and_fits_a_small_screen() {
        assert_eq!(place(None, &[EXTERNAL, LAPTOP], &MAIN), Placement { size: (1280.0, 820.0), pos: Some((2152.0, -160.5)) });
        let small = Rect { x: 0.0, y: 25.0, w: 1024.0, h: 700.0 };
        assert_eq!(place(None, &[small], &MAIN).size, (1024.0, 700.0));
    }

    #[test]
    fn a_saved_window_reopens_where_it_was_in_points_on_either_screen() {
        let on_ext = Rect { x: 2000.0, y: -300.0, w: 1400.0, h: 900.0 };
        assert_eq!(place(Some(on_ext), &[LAPTOP, EXTERNAL], &MAIN), Placement { size: (1400.0, 900.0), pos: Some((2000.0, -300.0)) });
        let on_laptop = Rect { x: 100.0, y: 60.0, w: 1300.0, h: 800.0 };
        assert_eq!(place(Some(on_laptop), &[EXTERNAL, LAPTOP], &MAIN).pos, Some((100.0, 60.0)));
    }

    #[test]
    fn a_window_saved_on_a_screen_that_is_gone_opens_centred_and_fits() {
        let on_ext = Rect { x: 2000.0, y: -300.0, w: 2400.0, h: 1300.0 };
        assert_eq!(place(Some(on_ext), &[LAPTOP], &MAIN), Placement { size: (1512.0, 945.0), pos: Some((0.0, 37.0)) });
        // The mini player's tall layout, centred on the laptop at its final size.
        let tall = Rect { x: 3000.0, y: 0.0, w: 300.0, h: 404.0 };
        assert_eq!(place(Some(tall), &[LAPTOP], &MINI).pos, Some((606.0, 307.5)));
    }

    #[test]
    fn a_window_hanging_off_its_screen_is_pulled_back_and_shrunk() {
        let r = Rect { x: 500.0, y: 500.0, w: 1400.0, h: 1000.0 };
        assert_eq!(place(Some(r), &[LAPTOP, EXTERNAL], &MAIN), Placement { size: (1400.0, 945.0), pos: Some((112.0, 37.0)) });
    }

    #[test]
    fn the_mini_player_comes_back_at_one_of_its_two_layouts() {
        let stretched = Rect { x: 400.0, y: 230.0, w: 555.0, h: 128.0 };
        assert_eq!(place(Some(stretched), &[LAPTOP], &MINI), Placement { size: (340.0, 100.0), pos: Some((400.0, 230.0)) });
        let tall = Rect { x: 400.0, y: 230.0, w: 680.0, h: 300.0 };
        assert_eq!(place(Some(tall), &[LAPTOP], &MINI).size, (300.0, 404.0));
    }

    #[test]
    fn only_a_whole_screen_frame_counts_as_full_screen() {
        let screen = Rect { x: 0.0, y: 0.0, w: 1512.0, h: 982.0 };
        assert!(Rect { x: 0.0, y: 0.0, w: 1512.0, h: 982.0 }.covers(&screen));
        // Zoomed: the work area, below the menu bar.
        assert!(!LAPTOP.covers(&screen));
        assert!(!Rect { x: 100.0, y: 60.0, w: 1300.0, h: 800.0 }.covers(&screen));
    }

    #[test]
    fn garbage_in_the_file_falls_back_to_the_default() {
        let bad = Rect { x: f64::NAN, y: 0.0, w: 100.0, h: 100.0 };
        assert_eq!(place(Some(bad), &[LAPTOP], &MAIN), place(None, &[LAPTOP], &MAIN));
        assert_eq!(place(None, &[], &MAIN).pos, None);
    }
}
