mod backup;
mod menu;
mod mini;
mod tray;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::Manager;

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
        // Remember size and position. VISIBLE is excluded on purpose: closing
        // the window hides it, and restoring "hidden" would launch an invisible app.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        .menu(|handle| menu::build(handle))
        .on_menu_event(|app, event| menu::on_event(app, event.id().as_ref()))
        .setup(|app| {
            // Snapshots left by a backup interrupted mid-VACUUM can be as large as the library.
            if let Ok(dir) = app.path().app_data_dir() {
                backup::sweep_snapshots(&dir);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![library_db_url, backup_library, selftest_take_backup, selftest_window, selftest_sleep, mini::toggle_mini_player, menu::selftest_menu, tray::set_menu_bar])
        .build(context)
        .unwrap_or_else(|e| startup_failed(&e));

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
    fn debug_builds_use_their_own_database() {
        // `cargo test` builds with debug assertions, like `npm run dev`.
        if std::env::var("BCP_DB_PATH").is_err() {
            assert_eq!(db_url(), "sqlite:library-dev.db");
        }
    }
}
