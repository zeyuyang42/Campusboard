fn main() {
    // App commands get `allow-<command>` permissions instead of being callable from every
    // window: capabilities/default.json grants them to the main window, and the mini
    // player window (capabilities/mini.json) gets none.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "library_db_url",
            "backup_library",
            "selftest_take_backup",
            "selftest_file",
            "selftest_window",
            "selftest_sleep",
            "toggle_mini_player",
            "selftest_menu",
            "set_menu_bar",
            "offline_dir",
        ]),
    ))
    .expect("failed to run tauri-build");
}
