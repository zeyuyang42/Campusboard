// Library export file and database backup. In the app the user picks the destination in a
// native save dialog. For the export, the dialog plugin adds exactly that file to the fs
// scope, so the capability file keeps its $APPDATA-only scope. The backup's destination is
// chosen, checked and written in Rust (src-tauri/src/backup.rs), never from a path the
// webview supplies. Browser mode (no fs) downloads the export and reads imports from a file
// input; backups need the app.
//
// The `debug*` arguments (dev builds only) skip the dialogs so the selftest can run the same
// code without putting a window on screen. They take `selftest-*` file names only.
import { getCore } from "../api/core";
import { isTauri } from "./env";
import { saveTextFile } from "./files";

const DEV = import.meta.env.DEV;

const today = () => new Date().toISOString().slice(0, 10);

const DEBUG_NAMES = { json: /^selftest-[A-Za-z0-9_-]+\.json$/, db: /^selftest-[A-Za-z0-9_-]+\.db$/ };

function debugOnly(name: string | undefined, ext: "json" | "db"): string | undefined {
  if (name === undefined) return undefined;
  if (!DEV || !isTauri) throw new Error("debug paths are only for dev builds of the app");
  if (!DEBUG_NAMES[ext].test(name)) throw new Error(`debug path must be a selftest-*.${ext} file name`);
  return name;
}

/** Export the library to a JSON file. Returns false if the save dialog was cancelled. */
export async function exportLibraryFile(opts: { history: boolean }, debugAppDataPath?: string): Promise<boolean> {
  const debug = debugOnly(debugAppDataPath, "json");
  const core = await getCore();
  const appVersion = isTauri ? await import("@tauri-apps/api/app").then((m) => m.getVersion()).catch(() => undefined) : undefined;
  const text = JSON.stringify(await core.exportLibrary({ history: opts.history, appVersion }), null, 1);
  if (debug) {
    const fs = await import("@tauri-apps/plugin-fs");
    const { BaseDirectory } = await import("@tauri-apps/api/path");
    await fs.writeTextFile(debug, text, { baseDir: BaseDirectory.AppData });
    return true;
  }
  return saveTextFile(`Bandcamp library ${today()}.json`, text, { name: "Library export", extensions: ["json"] });
}

/**
 * Copy the whole library database with SQLite's VACUUM INTO (safe while the app is running)
 * into a fresh snapshot in the data folder (SQLite won't write over a file), then let the
 * Rust side ask where to save it, check that place and copy the snapshot there atomically.
 * Returns the saved path, or null if cancelled. `debugTempName` (dev builds, selftest) saves
 * to that name in the temp folder without a dialog.
 */
export async function backupLibraryDatabase(debugTempName?: string): Promise<string | null> {
  if (!isTauri) throw new Error("Backing up the database needs the app.");
  const debug = debugOnly(debugTempName, "db");
  const { appDataDir, join, tempDir } = await import("@tauri-apps/api/path");
  const { invoke } = await import("@tauri-apps/api/core");
  const tmpName = `backup-${Date.now()}.tmp.db`;
  const core = await getCore();
  await core.backupDatabase(await join(await appDataDir(), tmpName));
  // The command removes the snapshot whatever happens (and startup sweeps stale ones).
  return invoke<string | null>("backup_library", {
    tmpName,
    defaultName: `Bandcamp library ${today()}.db`,
    debugDest: debug ? await join(await tempDir(), debug) : null,
  });
}
