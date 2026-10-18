// Library export file and database backup. In the app the user picks the destination in a
// native save dialog: the dialog plugin adds exactly that file to the fs scope, so the
// capability file keeps its $APPDATA-only scope. Browser mode (no fs) downloads the export
// and reads imports from a file input; backups need the app.
//
// `debugAppDataPath` (dev builds only) writes to a path relative to $APPDATA without any
// dialog, so the selftest can run the same code without putting a window on screen.
import { getCore } from "../api/core";
import { isTauri } from "./env";
import { saveTextFile } from "./files";

const DEV = import.meta.env.DEV;

const today = () => new Date().toISOString().slice(0, 10);

function debugOnly(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  if (!DEV || !isTauri) throw new Error("debug paths are only for dev builds of the app");
  if (!/^[A-Za-z0-9._-]+$/.test(path)) throw new Error("debug path must be a plain file name");
  return path;
}

/** Export the library to a JSON file. Returns false if the save dialog was cancelled. */
export async function exportLibraryFile(opts: { history: boolean }, debugAppDataPath?: string): Promise<boolean> {
  const debug = debugOnly(debugAppDataPath);
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
 * Copy the whole library database with SQLite's VACUUM INTO (safe while the app is running).
 * SQLite won't write over an existing file, so the snapshot goes to a fresh file in the data
 * folder first and is then copied to the chosen place. Returns the path, or null if cancelled.
 */
export async function backupLibraryDatabase(debugAppDataPath?: string): Promise<string | null> {
  if (!isTauri) throw new Error("Backing up the database needs the app.");
  const debug = debugOnly(debugAppDataPath);
  const fs = await import("@tauri-apps/plugin-fs");
  const { appDataDir, join } = await import("@tauri-apps/api/path");
  const dir = await appDataDir();
  let target: string;
  if (debug) target = await join(dir, debug);
  else {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const picked = await save({ defaultPath: `Bandcamp library ${today()}.db`, filters: [{ name: "SQLite database", extensions: ["db"] }] });
    if (!picked) return null;
    // Never write over the live library (or anything else the app keeps in its data folder).
    if (picked.startsWith(dir.endsWith("/") ? dir : `${dir}/`)) throw new Error("Choose a place outside the app's data folder for the backup.");
    target = picked;
  }
  const core = await getCore();
  const tmp = await join(dir, `backup-${Date.now()}.tmp.db`);
  try {
    await core.backupDatabase(tmp);
    await fs.copyFile(tmp, target);
  } finally {
    await fs.remove(tmp).catch(() => undefined);
  }
  return target;
}
