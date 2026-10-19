// The offline folder (#2) behind core's OfflineFiles. Core only ever passes names it made
// (`<track id>.mp3` and its `.part`); this checks again before building a path.
import type { OfflineFiles } from "@bc/core";

const SAFE_NAME = /^\d+\.mp3(\.part)?$/;
function checked(name: string): string {
  if (!SAFE_NAME.test(name)) throw new Error(`Not an offline file name: ${name}`);
  return name;
}

/**
 * The app: plugin-fs over the folder Rust created next to the library database and scoped
 * for fs and the asset protocol (lib.rs `offline_dir`). Writes stream (plugin-fs opens the
 * file and writes each chunk as plugin-http delivers it). <audio> plays the file through
 * convertFileSrc (asset://), which serves Range requests, so nothing is read into memory.
 * Null if the folder isn't there.
 */
export async function tauriOfflineFiles(): Promise<OfflineFiles | null> {
  const { invoke, convertFileSrc } = await import("@tauri-apps/api/core");
  const dir = await invoke<string>("offline_dir").catch(() => null);
  if (!dir) return null;
  const fs = await import("@tauri-apps/plugin-fs");
  const path = (name: string) => `${dir}/${checked(name)}`;
  return {
    write: (name, body) => fs.writeFile(path(name), body),
    rename: (from, to) => fs.rename(path(from), path(to)),
    remove: async (name) => { if (await fs.exists(path(name))) await fs.remove(path(name)); },
    exists: (name) => fs.exists(path(name)),
    list: async () => (await fs.readDir(dir)).filter((e) => e.isFile).map((e) => e.name),
    url: (name) => convertFileSrc(path(name)),
  };
}

/** Browser mode: an in-memory folder of Blobs, played from blob: URLs. Gone with the tab. */
export function memoryOfflineFiles(): OfflineFiles {
  const files = new Map<string, Blob>();
  const urls = new Map<string, string>();
  const drop = (name: string) => {
    const u = urls.get(name);
    if (u) URL.revokeObjectURL(u);
    urls.delete(name);
  };
  return {
    write: async (name, body) => { drop(checked(name)); files.set(name, await new Response(body).blob()); },
    rename: async (from, to) => {
      const b = files.get(checked(from));
      if (!b) throw new Error(`No file ${from}`);
      drop(from); drop(checked(to));
      files.delete(from);
      files.set(to, b.slice(0, b.size, "audio/mpeg"));
    },
    remove: async (name) => { drop(name); files.delete(name); },
    exists: async (name) => files.has(name),
    list: async () => [...files.keys()],
    url: (name) => {
      let u = urls.get(name);
      if (!u) { u = URL.createObjectURL(files.get(checked(name))!); urls.set(name, u); }
      return u;
    },
  };
}
