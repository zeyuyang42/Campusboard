// File helpers that work in the Tauri window (native dialogs + fs plugin) and fall back
// to browser primitives in browser-only dev mode.
import { isTauri } from "./env";

export async function pickTextFile(accept: { name: string; extensions: string[] }): Promise<{ name: string; text: string } | null> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    const path = await open({ multiple: false, directory: false, filters: [accept] });
    if (!path) return null;
    return { name: String(path).split("/").pop() ?? "file", text: await readTextFile(String(path)) };
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept.extensions.map((e) => `.${e}`).join(",");
    input.onchange = async () => {
      const f = input.files?.[0];
      resolve(f ? { name: f.name, text: await f.text() } : null);
    };
    input.click();
  });
}

export async function saveTextFile(defaultName: string, text: string, filter: { name: string; extensions: string[] }): Promise<boolean> {
  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    const path = await save({ defaultPath: defaultName, filters: [filter] });
    if (!path) return false;
    await writeTextFile(path, text);
    return true;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = defaultName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return true;
}

/**
 * Copy a user-picked image into the app's backgrounds folder; returns the stored file name.
 * The dialog adds the picked file to the fs scope. The capability scopes mkdir, copy-file and
 * read-file to `$APPDATA/backgrounds`: the only part of $APPDATA the webview reaches statically.
 */
export async function pickBackgroundImage(): Promise<string | null> {
  if (!isTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({ multiple: false, directory: false, filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }] });
  return path ? storeBackgroundImage(String(path)) : null;
}

/** Copy an image the fs scope allows (a dialog pick) into the backgrounds folder. */
export async function storeBackgroundImage(src: string): Promise<string> {
  const fs = await import("@tauri-apps/plugin-fs");
  const { BaseDirectory } = await import("@tauri-apps/api/path");
  const name = `${Date.now()}-${src.split("/").pop()?.replace(/[^A-Za-z0-9._-]/g, "_") ?? "background"}`;
  await fs.mkdir("backgrounds", { baseDir: BaseDirectory.AppData, recursive: true });
  await fs.copyFile(src, `backgrounds/${name}`, { toPathBaseDir: BaseDirectory.AppData });
  return name;
}

const objectUrls = new Map<string, string>();
/** Resolve a stored background file name to something an <img>/CSS url() can load. */
export async function backgroundFileUrl(name: string): Promise<string | null> {
  if (!isTauri || !name) return null;
  const cached = objectUrls.get(name);
  if (cached) return cached;
  try {
    const fs = await import("@tauri-apps/plugin-fs");
    const { BaseDirectory } = await import("@tauri-apps/api/path");
    const bytes = await fs.readFile(`backgrounds/${name}`, { baseDir: BaseDirectory.AppData });
    const ext = name.split(".").pop()?.toLowerCase();
    const type = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    objectUrls.set(name, url);
    return url;
  } catch {
    return null;
  }
}

export async function appVersion(): Promise<string> {
  if (!isTauri) return "dev (browser)";
  const { getVersion } = await import("@tauri-apps/api/app");
  return getVersion();
}
