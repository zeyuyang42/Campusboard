// Dropping a Bandcamp link onto the main window (#92). The webview gets ordinary HTML5 drag
// events because tauri.conf.json turns the native file-drop handler off for the main window
// (see AGENTS.md); dropped files are never read, only link text is. lib.rs keeps the window
// on the app's own pages whatever happens here.
import { normalizeBandcampUrl, isBandcampHost } from "@bc/core";
import { getCore } from "../api/core";
import { navigateTo } from "./navigation";
import { friendlyError } from "./errors";

/** The part of DataTransfer the parser reads, so tests can pass plain objects. */
export interface DropData {
  readonly types: readonly string[];
  getData(format: string): string;
}

/** Set on every drag that starts in the page, so the window handler leaves it to its targets. */
export const INTERNAL_TYPE = "application/x-bc-internal";

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
 * Any website's homepage normalizes to a custom-domain artist, and people drag random tabs.
 * So a dropped custom-domain artist needs an explicit /music or /releases path, or a host
 * that is already in the library. bandcamp.com subdomains pass as they are.
 */
async function trustedArtist(raw: string, host: string): Promise<boolean> {
  if (isBandcampHost(host)) return true;
  if (/^\/(music|releases)\/?$/.test(new URL(raw.trim()).pathname)) return true;
  const artists = await (await getCore()).artists().catch(() => []);
  return artists.some((a) => { try { return new URL(a.url).hostname.toLowerCase() === host; } catch { return false; } });
}

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
    if (!(await trustedArtist(raw, n.host))) return { kind: "rejected", message: NOT_BANDCAMP };
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

const isEditable = (t: EventTarget | null) =>
  t instanceof Element && !!t.closest('input, textarea, [contenteditable=""], [contenteditable="true"]');

/**
 * Window-level listeners for the main window. A drag that starts in the page carries
 * INTERNAL_TYPE and is left to its targets (queue rows); a drag carrying files is always
 * cancelled, so WebKit never opens a file in the window; plain text dragged onto a text
 * field is left to WebKit, which inserts it. Every other outside drag is taken over.
 */
export function installDropLink(target: Window, h: DropHandlers): () => void {
  let depth = 0;
  const types = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []);
  /** null: leave the event alone; otherwise the drag's types. */
  const claim = (e: DragEvent): string[] | null => {
    if (!e.dataTransfer) return null;
    const t = types(e);
    if (t.includes("Files")) return t;
    if (t.includes(INTERNAL_TYPE)) return null;
    if (isEditable(e.target) && !extractDroppedUrl(e.dataTransfer)) return null;
    return t;
  };
  const listeners: Record<string, (e: DragEvent) => void> = {
    dragstart: (e) => { try { e.dataTransfer?.setData(INTERNAL_TYPE, "1"); } catch { /* read-only */ } },
    dragenter: (e) => {
      const t = claim(e);
      if (!t) return;
      e.preventDefault();
      depth++;
      if (hasLinkData(t) && !t.includes("Files")) h.onActive(true);
    },
    dragover: (e) => {
      const t = claim(e);
      if (!t) return;
      e.preventDefault();
      // WebKit's answer reaches the page, but wry turns a "none" into Copy for the cursor.
      e.dataTransfer!.dropEffect = hasLinkData(t) && !t.includes("Files") ? "copy" : "none";
    },
    dragleave: (e) => {
      if (!e.dataTransfer || types(e).includes(INTERNAL_TYPE)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) h.onActive(false);
    },
    drop: (e) => {
      depth = 0;
      h.onActive(false);
      const t = claim(e);
      if (!t) return;
      e.preventDefault();
      if (!hasLinkData(t)) return;
      const url = extractDroppedUrl(e.dataTransfer!);
      // Files are never read and are ignored without a word (a Finder file may also come
      // with its file:// URL as text); a web link that also carries files still counts.
      if (t.includes("Files") && !url) return;
      void routeDroppedUrl(url).then((r) => { if (r.kind === "rejected") h.onNote(r.message); });
    },
  };
  for (const [type, fn] of Object.entries(listeners)) target.addEventListener(type, fn as EventListener, true);
  return () => {
    for (const [type, fn] of Object.entries(listeners)) target.removeEventListener(type, fn as EventListener, true);
  };
}
