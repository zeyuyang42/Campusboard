// Dropping a Bandcamp link onto the main window (#92). The webview gets ordinary HTML5 drag
// events because tauri.conf.json turns the native file-drop handler off for the main window
// (see AGENTS.md); dropped files are never read, only link text is.
import { normalizeBandcampUrl } from "@bc/core";
import { getCore } from "../api/core";
import { navigateTo } from "./navigation";
import { friendlyError } from "./errors";

/** The part of DataTransfer the parser reads, so tests can pass plain objects. */
export interface DropData {
  readonly types: readonly string[];
  getData(format: string): string;
}

const WEB_URL = /^https?:\/\/\S+$/i;

/** Whether a drag carries text a link could be read from (not just files). */
export function hasLinkData(types: readonly string[]): boolean {
  return types.includes("text/uri-list") || types.includes("text/plain");
}

/**
 * The first http(s) URL in a drop: `text/uri-list` first (comment lines start with `#`),
 * then any whitespace-separated token of `text/plain`. Null when there is none, e.g. a
 * drop of files only.
 */
export function extractDroppedUrl(dt: DropData): string | null {
  const read = (type: string) => {
    try { return dt.types.includes(type) ? dt.getData(type) : ""; } catch { return ""; }
  };
  const fromList = read("text/uri-list").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const fromText = read("text/plain").split(/\s+/).map((t) => t.replace(/^<|>$/g, ""));
  return [...fromList, ...fromText].find((s) => WEB_URL.test(s)) ?? null;
}

export type DropOutcome = { kind: "import" | "browse"; url: string } | { kind: "rejected"; message: string };

export const NOT_BANDCAMP = "Not a Bandcamp link";

/**
 * Route a dropped URL the way the Import page treats a pasted one: album and track links
 * start an import job and show its progress, artist and label links open Browse.
 */
export async function routeDroppedUrl(raw: string | null): Promise<DropOutcome> {
  let n: ReturnType<typeof normalizeBandcampUrl>;
  try {
    if (!raw) return { kind: "rejected", message: NOT_BANDCAMP };
    n = normalizeBandcampUrl(raw);
  } catch {
    return { kind: "rejected", message: NOT_BANDCAMP };
  }
  if (n.kind === "artist") {
    navigateTo(`/browse?url=${encodeURIComponent(n.url)}`);
    return { kind: "browse", url: n.url };
  }
  try {
    await (await getCore()).import({ url: n.url });
  } catch (e) {
    return { kind: "rejected", message: friendlyError(e) };
  }
  navigateTo("/import");
  return { kind: "import", url: n.url };
}

export interface DropHandlers {
  /** True while an outside drag with link text is over the window: draws the outline. */
  onActive: (active: boolean) => void;
  /** A quiet note, e.g. "Not a Bandcamp link". */
  onNote: (message: string) => void;
}

/**
 * Window-level listeners for the main window. Drags that start inside the page (queue rows,
 * links, art) are left to their own handlers; outside drags are always taken over, so WebKit
 * never opens a dropped file or link in the webview itself.
 */
export function installDropLink(target: Window, h: DropHandlers): () => void {
  let internal = false;
  let depth = 0;
  const outside = (e: DragEvent) => !internal && !!e.dataTransfer;
  const types = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []);
  const listeners: Record<string, (e: DragEvent) => void> = {
    dragstart: () => { internal = true; },
    dragend: () => { internal = false; },
    dragenter: (e) => {
      if (!outside(e)) return;
      e.preventDefault();
      depth++;
      if (hasLinkData(types(e))) h.onActive(true);
    },
    dragover: (e) => {
      if (!outside(e)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = hasLinkData(types(e)) ? "copy" : "none";
    },
    dragleave: (e) => {
      if (!outside(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) h.onActive(false);
    },
    drop: (e) => {
      if (!outside(e)) { internal = false; return; }
      e.preventDefault();
      depth = 0;
      h.onActive(false);
      // Files alone are ignored without a word: the app never reads dropped files.
      if (!hasLinkData(types(e))) return;
      void routeDroppedUrl(extractDroppedUrl(e.dataTransfer!)).then((r) => { if (r.kind === "rejected") h.onNote(r.message); });
    },
  };
  for (const [type, fn] of Object.entries(listeners)) target.addEventListener(type, fn as EventListener, true);
  return () => {
    for (const [type, fn] of Object.entries(listeners)) target.removeEventListener(type, fn as EventListener, true);
  };
}
