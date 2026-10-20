mod backup;
mod geometry;
mod menu;
mod mini;
mod tray;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::Manager;

use tauri_plugin_sql::{Migration, MigrationKind};

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
        Migration {
            version: 4,
            description: "releases removed from the library that a sync must not re-import",
            sql: include_str!("../migrations/0004_fan_dismissed.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "listening history",
            sql: include_str!("../migrations/0005_plays.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "new releases from library artists",
            sql: include_str!("../migrations/0006_new_releases.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "library import bookkeeping",
            sql: include_str!("../migrations/0007_library_import.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 8,
            description: "offline copies of tracks",
            sql: include_str!("../migrations/0008_offline.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 9,
            description: "album notes and ratings",
            sql: include_str!("../migrations/0009_album_notes.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 10,
            description: "resume points for long tracks and radio episodes",
            sql: include_str!("../migrations/0010_resume_positions.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 11,
            description: "smart playlists",
            sql: include_str!("../migrations/0011_smart_playlists.sql"),
            kind: MigrationKind::Up,
        },
    ]
}

/// The library database, relative to the app data dir. Debug builds (`npm run dev`, the
/// selftest) use their own file so a feature branch never migrates the installed app's
/// library: a build that lacks an applied migration refuses to open it.
/// `BCP_DB_PATH` (an absolute path, debug builds only) points a dev run at a scratch file.
fn db_url() -> String {
    if cfg!(debug_assertions) {
        match std::env::var("BCP_DB_PATH") {
            Ok(p) if !p.is_empty() => format!("sqlite:{p}"),
            _ => "sqlite:library-dev.db".into(),
        }
    } else {
        "sqlite:library.db".into()
    }
}

/// The frontend loads the same database the plugin preloaded and migrated.
#[tauri::command]
fn library_db_url() -> String {
    db_url()
}

/// The live database file, resolved the way the sql plugin resolves `db_url()` (relative
/// names live in the app config folder).
fn live_db_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let url = db_url();
    let p = PathBuf::from(url.strip_prefix("sqlite:").unwrap_or(&url));
    if p.is_absolute() {
        Some(p)
    } else {
        app.path().app_config_dir().ok().map(|d| d.join(p))
    }
}

/// Offline copies of tracks (#2) live next to the database they belong to, in
/// `<db stem>-offline/`: `library-offline` for the app, `library-dev-offline` for dev runs and
/// the selftest, `<scratch>-offline` beside a `BCP_DB_PATH`. Each library sweeps its own folder
/// of files it doesn't name, so two libraries must never share one. Application Support, not
/// Caches: macOS may purge Caches, and a copy kept for offline listening must stay.
fn offline_dir_for(db: &std::path::Path) -> PathBuf {
    let stem = db.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "library".into());
    db.with_file_name(format!("{stem}-offline"))
}

/// The offline folder, created at startup and added to the fs and asset protocol scopes
/// (that folder only, recursively). None if it couldn't be created.
struct OfflineDir(Option<PathBuf>);

fn setup_offline_dir(app: &tauri::App) -> Option<PathBuf> {
    use tauri_plugin_fs::FsExt;
    let dir = offline_dir_for(&live_db_path(app.handle())?);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("offline folder {}: {e}", dir.display());
        return None;
    }
    // The real path: the scopes compare against it with symlinks resolved (/tmp on macOS).
    let dir = std::fs::canonicalize(&dir).ok()?;
    if let Err(e) = app.fs_scope().allow_directory(&dir, true) {
        eprintln!("offline folder fs scope: {e}");
        return None;
    }
    if let Err(e) = app.asset_protocol_scope().allow_directory(&dir, true) {
        eprintln!("offline folder asset scope: {e}");
        return None;
    }
    Some(dir)
}

/// The absolute path of the offline folder, for the frontend's OfflineFiles.
#[tauri::command]
fn offline_dir(state: tauri::State<OfflineDir>) -> Result<String, String> {
    state.0.as_ref().map(|p| p.to_string_lossy().into_owned()).ok_or_else(|| "no offline folder".into())
}

/// Save a database snapshot the frontend wrote with VACUUM INTO (`$APPDATA/<tmp_name>`) to a
/// place the user picks in the native save dialog. The destination never comes from the
/// webview in release builds; it is checked (backup::check_dest) and written atomically.
/// `debug_dest` (debug builds only, for the selftest) replaces the dialog with a
/// `selftest-*.db` path. The snapshot is always removed. Returns the saved path, or None
/// if the dialog was cancelled.
#[tauri::command]
async fn backup_library(app: tauri::AppHandle, tmp_name: String, default_name: String, debug_dest: Option<String>) -> Result<Option<String>, String> {
    if !backup::is_snapshot_name(&tmp_name) {
        return Err("invalid snapshot name".into());
    }
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let snapshot = data_dir.join(&tmp_name);
    let result = save_snapshot(&app, &snapshot, &data_dir, &default_name, debug_dest);
    let _ = std::fs::remove_file(&snapshot);
    result
}

fn save_snapshot(app: &tauri::AppHandle, snapshot: &std::path::Path, data_dir: &std::path::Path, default_name: &str, debug_dest: Option<String>) -> Result<Option<String>, String> {
    let dest = match debug_dest {
        Some(d) => {
            let p = PathBuf::from(&d);
            let named = p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("selftest-"));
            if !cfg!(debug_assertions) || !named {
                return Err("debug destinations are only for the selftest in dev builds".into());
            }
            p
        }
        None => {
            use tauri_plugin_dialog::DialogExt;
            let picked = app
                .dialog()
                .file()
                .set_file_name(default_name)
                .add_filter("SQLite database", &["db"])
                .blocking_save_file();
            match picked.and_then(|f| f.into_path().ok()) {
                Some(p) => p,
                None => return Ok(None),
            }
        }
    };
    let mut protected = vec![data_dir.to_path_buf()];
    if let Ok(c) = app.path().app_config_dir() {
        protected.push(c);
    }
    let live: Vec<PathBuf> = live_db_path(app).into_iter().collect();
    let target = backup::check_dest(&dest, &protected, &live)?;
    backup::atomic_copy(snapshot, &target).map_err(|e| format!("Couldn't write the backup ({e})."))?;
    Ok(Some(target.to_string_lossy().into_owned()))
}

/// Selftest helper (debug builds only): the first 15 bytes of a `selftest-*.db` backup in
/// the temp folder, then delete it.
#[tauri::command]
fn selftest_take_backup(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    let tmp = std::fs::canonicalize(std::env::temp_dir()).map_err(|e| e.to_string())?;
    let parent = p.parent().and_then(|d| std::fs::canonicalize(d).ok());
    let named = p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("selftest-"));
    if !cfg!(debug_assertions) || !named || parent.as_deref() != Some(tmp.as_path()) {
        return Err("only selftest backups in the temp folder".into());
    }
    let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
    std::fs::remove_file(&p).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&bytes[..bytes.len().min(15)]).into_owned())
}

/// Selftest helper (debug builds only) standing in for the native file dialogs, which add
/// the picked file to the fs scope and nothing else:
/// - `allow` adds `<temp>/<name>` (a `selftest-*.json` or `selftest-*.png` name) to the fs
///   scope, as picking it in a save or open dialog would, and returns its real path.
/// - `drop` deletes that temp file and any `<digits>-<name>` copy in `$APPDATA/backgrounds`
///   (what storing it as a theme background makes), which the webview cannot remove.
#[tauri::command]
fn selftest_file(app: tauri::AppHandle, action: String, name: String) -> Result<String, String> {
    use tauri_plugin_fs::FsExt;
    let named = name.starts_with("selftest-")
        && (name.ends_with(".json") || name.ends_with(".png"))
        && name.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    if !cfg!(debug_assertions) || !named {
        return Err("only selftest files in dev builds".into());
    }
    let path = std::fs::canonicalize(std::env::temp_dir()).map_err(|e| e.to_string())?.join(&name);
    match action.as_str() {
        "allow" => {
            app.fs_scope().allow_file(&path).map_err(|e| e.to_string())?;
            Ok(path.to_string_lossy().into_owned())
        }
        "drop" => {
            let _ = std::fs::remove_file(&path);
            let bg = app.path().app_data_dir().map_err(|e| e.to_string())?.join("backgrounds");
            for entry in std::fs::read_dir(&bg).into_iter().flatten().flatten() {
                let f = entry.file_name().to_string_lossy().into_owned();
                if f.split_once('-').is_some_and(|(ms, rest)| !ms.is_empty() && ms.bytes().all(|b| b.is_ascii_digit()) && rest == name) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
            Ok(String::new())
        }
        _ => Err(format!("unknown action {action}")),
    }
}

/// Bumped by every `selftest_window` call, so only the latest armed guard can act.
static GUARD_GEN: AtomicU64 = AtomicU64::new(0);
/// How many times a guard had to show the main window again.
static GUARD_SHOWS: AtomicU64 = AtomicU64::new(0);

/// Selftest helper (debug builds only) for a page WebKit may stop running (#67): one whose
/// window is hidden, or covered (the display asleep or locked), and whose media is muted.
/// - `keep-awake` asks WebKit not to throttle or suspend the page for that (WebKit SPI, each
///   checked with respondsToSelector first) and holds an App Nap activity for the app.
///   Returns which of them applied.
/// - `hide` hides the main window and arms a guard; `arm` only arms one (before something
///   else hides or minimizes it). After `ms` (at most 60 s) the latest armed guard unminimizes
///   and shows the window if it is still hidden, which wakes the page, so a step that hides,
///   sleeps and shows it again can't stall for good.
/// - `show` disarms the guard and shows the window.
///
/// Returns `{ guardShows, awake }`: how many times a guard had to fire.
#[tauri::command]
async fn selftest_window(app: tauri::AppHandle, action: String, ms: Option<u64>) -> Result<serde_json::Value, String> {
    if !cfg!(debug_assertions) {
        return Err("selftest only".into());
    }
    if action == "drag-drop" {
        // The effective config of the main window: false hands drags to WebKit (#92).
        let main = app.config().app.windows.iter().find(|w| w.label == "main").ok_or("no main window config")?;
        return Ok(serde_json::json!({ "dragDropEnabled": main.drag_drop_enabled }));
    }
    let generation = GUARD_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let win = app.get_webview_window("main").ok_or("no main window")?;
    let mut awake = serde_json::Value::Null;
    match action.as_str() {
        "keep-awake" => awake = keep_awake(&win),
        "show" => menu::show_main(&app),
        "hide" | "arm" => {
            if action == "hide" {
                win.hide().map_err(|e| e.to_string())?;
            }
            let ms = ms.unwrap_or(15_000).min(60_000);
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(ms));
                if GUARD_GEN.load(Ordering::SeqCst) != generation {
                    return;
                }
                let hidden = !win.is_visible().unwrap_or(true) || win.is_minimized().unwrap_or(false);
                if hidden {
                    GUARD_SHOWS.fetch_add(1, Ordering::SeqCst);
                    eprintln!("selftest: the main window was still hidden after {ms} ms; showing it");
                    menu::show_main(win.app_handle());
                }
            });
        }
        other => return Err(format!("unknown action {other}")),
    }
    Ok(serde_json::json!({ "guardShows": GUARD_SHOWS.load(Ordering::SeqCst), "awake": awake }))
}

#[cfg(target_os = "macos")]
fn keep_awake(win: &tauri::WebviewWindow) -> serde_json::Value {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send, sel};

    /// `[obj setter:NO]` if obj responds to it; records whether it did.
    macro_rules! turn_off {
        ($obj:expr, $setter:ident, $out:ident) => {{
            let ok: bool = msg_send![$obj, respondsToSelector: sel!($setter:)];
            if ok {
                let _: () = msg_send![$obj, $setter: false];
            }
            $out.insert(stringify!($setter).to_string(), serde_json::Value::Bool(ok));
        }};
    }

    let (tx, rx) = std::sync::mpsc::channel();
    let sent = win.with_webview(move |wv| {
        let mut out = serde_json::Map::new();
        // SAFETY: inner() is the live WKWebView, and with_webview runs this on the main thread.
        unsafe {
            if let Some(view) = (wv.inner() as *mut AnyObject).as_ref() {
                turn_off!(view, _setWindowOcclusionDetectionEnabled, out);
                let config: *mut AnyObject = msg_send![view, configuration];
                if let Some(config) = config.as_ref() {
                    let prefs: *mut AnyObject = msg_send![config, preferences];
                    if let Some(prefs) = prefs.as_ref() {
                        turn_off!(prefs, _setBackgroundWebContentRunningBoardThrottlingEnabled, out);
                        turn_off!(prefs, _setPageVisibilityBasedProcessSuppressionEnabled, out);
                        turn_off!(prefs, _setHiddenPageDOMTimerThrottlingEnabled, out);
                    }
                }
            }
            // NSActivityUserInitiatedAllowingIdleSystemSleep: no App Nap for the app process.
            let info: *mut AnyObject = msg_send![class!(NSProcessInfo), processInfo];
            let reason: *mut AnyObject = msg_send![class!(NSString), stringWithUTF8String: c"selftest".as_ptr()];
            if let (Some(info), Some(reason)) = (info.as_ref(), reason.as_ref()) {
                let token: *mut AnyObject = msg_send![info, beginActivityWithOptions: 0x00EF_FFFFu64, reason: reason];
                // Held for the rest of the run.
                std::mem::forget(Retained::retain(token));
                out.insert("appNapActivity".into(), serde_json::Value::Bool(!token.is_null()));
            }
        }
        let _ = tx.send(serde_json::Value::Object(out));
    });
    if sent.is_err() {
        return serde_json::Value::Null;
    }
    rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap_or(serde_json::Value::Null)
}

#[cfg(not(target_os = "macos"))]
fn keep_awake(_win: &tauri::WebviewWindow) -> serde_json::Value {
    serde_json::Value::Null
}


/// Selftest helper (debug builds only): resolve after `ms` (at most 5 min), timed on the Rust
/// side, raced with a page timer in the selftest's waits: WebKit throttles a hidden or covered
/// page's timers (#67).
#[tauri::command]
async fn selftest_sleep(ms: u64) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Err("selftest only".into());
    }
    let d = std::time::Duration::from_millis(ms.min(300_000));
    tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await.map_err(|e| e.to_string())
}


const RELEASES_URL: &str = "https://github.com/zeyuyang42/bandcamp-player/releases/latest";

/// Why startup failed, from the error `Builder::build` returned.
#[derive(Debug, PartialEq, Eq)]
enum StartupFailure {
    /// sqlx VersionMissing: a newer build applied a migration this build doesn't have.
    NewerLibrary,
    /// sqlx VersionMismatch: an applied migration file was edited (even a comment).
    EditedMigration,
    Other,
}

impl StartupFailure {
    fn classify(detail: &str) -> Self {
        if detail.contains("previously applied but is missing") {
            Self::NewerLibrary
        } else if detail.contains("previously applied but has been modified") {
            Self::EditedMigration
        } else {
            Self::Other
        }
    }

    fn exit_code(&self) -> i32 {
        match self {
            Self::Other => 1,
            Self::NewerLibrary => 2,
            Self::EditedMigration => 3,
        }
    }

    fn message(&self, detail: &str) -> (&'static str, String) {
        match self {
            Self::NewerLibrary => (
                "Library opened by a newer version",
                format!(
                    "Your library was opened by a newer version of Bandcamp Player, so this \
                     version can't use it. Install the latest release:\n\n{RELEASES_URL}\n\n({detail})"
                ),
            ),
            Self::EditedMigration => (
                "Library schema mismatch",
                format!(
                    "This build's database schema differs from the one your library was set up \
                     with. Install the latest release:\n\n{RELEASES_URL}\n\n({detail})"
                ),
            ),
            Self::Other => ("Bandcamp Player could not start", detail.to_string()),
        }
    }
}

/// Startup failed before any window could show: explain it in a native alert and exit
/// instead of panicking with no window. `BC_NO_DIALOG=1` (debug builds only) skips the
/// alert so the failure path can be checked by exit code without UI.
fn startup_failed(err: &tauri::Error) -> ! {
    let detail = err.to_string();
    let failure = StartupFailure::classify(&detail);
    eprintln!("startup failed ({failure:?}): {detail}");
    let quiet = cfg!(debug_assertions) && std::env::var("BC_NO_DIALOG").is_ok_and(|v| v == "1");
    if !quiet {
        let (title, body) = failure.message(&detail);
        let open = "Open Releases".to_string();
        let choice = rfd::MessageDialog::new()
            .set_level(rfd::MessageLevel::Error)
            .set_title(title)
            .set_description(body)
            .set_buttons(rfd::MessageButtons::OkCancelCustom(open.clone(), "Quit".into()))
            .show();
        if choice == rfd::MessageDialogResult::Custom(open) {
            let _ = tauri_plugin_opener::open_url(RELEASES_URL, None::<&str>);
        }
    }
    std::process::exit(failure.exit_code());
}

/// Whether the main webview may load `url`: only the app's own pages (`tauri://localhost`,
/// `http://tauri.localhost`, or the dev server in debug builds). A backstop for #92: a file or
/// link that WebKit would otherwise open in the window can never replace the app (and drop
/// the player state). External links go through the opener plugin, never navigation.
fn is_app_url(url: &tauri::Url, dev_url: Option<&tauri::Url>) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost") || dev_url.is_some_and(|d| d.origin() == url.origin()),
        _ => false,
    }
}

/// Applies `is_app_url` to the main window; the mini window loads only its own page anyway.
fn navigation_guard<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("navigation-guard")
        .on_navigation(|webview, url| {
            if webview.label() != "main" {
                return true;
            }
            let dev = if cfg!(debug_assertions) { webview.config().build.dev_url.clone() } else { None };
            let ok = is_app_url(url, dev.as_ref());
            if !ok {
                eprintln!("blocked navigation of the main window to a {} URL", url.scheme());
            }
            ok
        })
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let db = db_url();
    let mut context = tauri::generate_context!();
    // Preload is set here, not in tauri.conf.json, so the file follows the build profile.
    // Preloading runs the migrations during plugin setup, where an error reaches `build()`.
    context
        .config_mut()
        .plugins
        .0
        .insert("sql".into(), serde_json::json!({ "preload": [db] }));

    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(&db, migrations())
                .build(),
        )
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(navigation_guard())
        // Size and position are kept by geometry.rs: noted on every move and resize, written
        // when a window closes (hides) and at quit.
        .on_window_event(|window, event| {
            let (Some(w), Some(geo)) = (window.get_webview_window(window.label()), window.try_state::<geometry::Geometry>()) else {
                return;
            };
            match event {
                tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => geo.record(&w),
                tauri::WindowEvent::CloseRequested { .. } => {
                    geo.record(&w);
                    geo.save();
                }
                _ => {}
            }
        })
        .menu(|handle| menu::build(handle))
        .on_menu_event(|app, event| menu::on_event(app, event.id().as_ref()))
        .setup(|app| {
            // Snapshots left by a backup interrupted mid-VACUUM can be as large as the library.
            if let Ok(dir) = app.path().app_data_dir() {
                backup::sweep_snapshots(&dir);
            }
            let offline = setup_offline_dir(app);
            app.manage(OfflineDir(offline));
            // The main window is created hidden (tauri.conf.json) so it is sized and placed
            // before anyone sees it.
            let geo = geometry::Geometry::load(app);
            if let Some(main) = app.get_webview_window("main") {
                geo.restore(&main, &geometry::MAIN);
                let _ = main.show();
                let _ = main.set_focus();
            }
            app.manage(geo);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![library_db_url, offline_dir, backup_library, selftest_take_backup, selftest_file, selftest_window, selftest_sleep, mini::toggle_mini_player, menu::selftest_menu, tray::set_menu_bar])
        .build(context)
        .unwrap_or_else(|e| startup_failed(&e));

    app.run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(geo) = app.try_state::<geometry::Geometry>() {
                for w in app.webview_windows().values() {
                    geo.record(w);
                }
                geo.save();
            }
        }
        // Dock icon clicked while the window is hidden (closed) or minimized.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            menu::show_main(app);
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (app, event);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::migrate::MigrateError;

    /// The text `Builder::build` reports when the sql plugin's preload migration fails.
    fn build_error(e: MigrateError) -> String {
        let plugin = tauri_plugin_sql::Error::Migration(e);
        tauri::Error::PluginInitialization("sql".into(), plugin.to_string()).to_string()
    }

    #[test]
    fn registers_every_migration_file_in_order() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
        let mut files: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok()?.file_name().into_string().ok())
            .filter(|f| f.ends_with(".sql"))
            .collect();
        files.sort();
        let ms = migrations();
        assert_eq!(ms.len(), files.len());
        for (i, (m, f)) in ms.iter().zip(&files).enumerate() {
            assert_eq!(m.version, i as i64 + 1);
            assert!(f.starts_with(&format!("{:04}_", i + 1)), "{f}");
        }
        assert!(ms.last().unwrap().sql.contains("smart_playlists"));
    }

    /// The native file-drop handler swallows every drag before WebKit sees it, link text
    /// included; the main window turns it off so a dropped Bandcamp link reaches the page (#92).
    #[test]
    fn main_window_leaves_drops_to_the_webview() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let main = conf["app"]["windows"].as_array().unwrap().iter().find(|w| w["label"] == "main").unwrap();
        assert_eq!(main["dragDropEnabled"], serde_json::Value::Bool(false));
    }

    #[test]
    fn main_window_navigates_only_to_app_pages() {
        let u = |s: &str| tauri::Url::parse(s).unwrap();
        let dev = u("http://localhost:5173");
        for ok in ["tauri://localhost", "tauri://localhost/library", "http://tauri.localhost/album/3"] {
            assert!(is_app_url(&u(ok), None), "{ok}");
        }
        assert!(is_app_url(&u("http://localhost:5173/import?x=1"), Some(&dev)));
        assert!(!is_app_url(&u("http://localhost:5173/"), None), "dev server only in debug builds");
        for bad in [
            "file:///Users/me/Desktop/song.mp3",
            "https://artist.bandcamp.com/album/x",
            "http://localhost:5174/",
            "https://localhost:5173/",
            "tauri://evil.example",
            "about:blank",
            "data:text/html,hi",
        ] {
            assert!(!is_app_url(&u(bad), Some(&dev)), "{bad}");
        }
    }

    #[test]
    fn classifies_migration_errors() {
        let missing = build_error(MigrateError::VersionMissing(7));
        assert_eq!(StartupFailure::classify(&missing), StartupFailure::NewerLibrary);
        let edited = build_error(MigrateError::VersionMismatch(6));
        assert_eq!(StartupFailure::classify(&edited), StartupFailure::EditedMigration);
        assert_eq!(StartupFailure::classify(&build_error(MigrateError::Dirty(3))), StartupFailure::Other);
        assert_eq!(StartupFailure::classify("failed to setup app: boom"), StartupFailure::Other);
    }

    #[test]
    fn newer_library_message_points_to_the_release() {
        let (title, body) = StartupFailure::NewerLibrary.message("migration 7 is missing");
        assert!(title.contains("newer version"));
        assert!(body.contains(RELEASES_URL) && body.contains("migration 7"));
    }

    #[test]
    fn each_library_has_its_own_offline_folder() {
        let support = std::path::Path::new("/Users/x/Library/Application Support/com.bandcampplayer.app");
        assert_eq!(offline_dir_for(&support.join("library.db")), support.join("library-offline"));
        assert_eq!(offline_dir_for(&support.join("library-dev.db")), support.join("library-dev-offline"));
        let scratch = std::path::Path::new("/tmp/run/scratch.db");
        assert_eq!(offline_dir_for(scratch), std::path::Path::new("/tmp/run/scratch-offline"));
    }

    #[test]
    fn debug_builds_use_their_own_database() {
        // `cargo test` builds with debug assertions, like `npm run dev`.
        if std::env::var("BCP_DB_PATH").is_err() {
            assert_eq!(db_url(), "sqlite:library-dev.db");
        }
    }
}
