// Keeps --accent / --ambient-* on :root in step with the playing track's artwork and the theme.
// Palette v2 (#110): the same art change also fetches the raw swatches and publishes them
// boosted (backdrop/swatches.ts); outside the conservative backdrop the ambient colours come
// from the boosted swatches, so the wash and the panel tint follow the vivid palette.
import { accentRatio, accentSurface, artKeyOf, fitPalette, type AppliedPalette, type ArtKey, type ArtPalette } from "@bc/core";
import { usePlayer } from "../player/store";
import { useTheme } from "./store";
import { getCore } from "../api/core";
import { currentSwatches, publishSwatches, setSwatchAppearance } from "../backdrop/swatches";

let currentKey: number | null = null;
let currentPalette: ArtPalette | null = null;
let seq = 0;
let applied: AppliedPalette | null = null;
const listeners = new Set<() => void>();

/** The colors last painted on :root (null: no art, the theme's accent applies). */
export const appliedPalette = () => applied;
/** Called after every repaint; returns an unsubscribe function. */
export function onPaletteChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function paint() {
  const root = document.documentElement.style;
  const theme = useTheme.getState().resolved;
  setSwatchAppearance(theme.mode === "dark");
  const vivid = theme.backdrop.mode === "conservative" ? null : currentSwatches();
  const fit = currentPalette ? fitPalette(currentPalette, accentSurface(theme), accentRatio(theme)) : null;
  if (fit) {
    root.setProperty("--accent", fit.accent);
    root.setProperty("--accent-text", fit.accentText);
  } else {
    root.removeProperty("--accent");
    root.removeProperty("--accent-text");
  }
  if (vivid?.swatches.length) {
    root.setProperty("--ambient-1", vivid.swatches[0].hex);
    root.setProperty("--ambient-2", (vivid.swatches[1] ?? vivid.swatches[0]).hex);
  } else {
    root.setProperty("--ambient-1", fit?.ambient1 ?? "transparent");
    root.setProperty("--ambient-2", fit?.ambient2 ?? "transparent");
  }
  applied = fit;
  listeners.forEach((fn) => fn());
}

/** The art of a queue entry: album art by art_id, a Radio episode by its image_id. */
function artKeyFor(entry: { art_id: number | null; radio?: { image_id: number | null } | null } | undefined): ArtKey | null {
  if (!entry) return null;
  if (entry.art_id) return { artId: entry.art_id };
  if (entry.radio?.image_id) return { imageId: entry.radio.image_id };
  return null;
}

async function onArtChange(key: ArtKey | null) {
  const k = key ? artKeyOf(key) : null;
  if (k === currentKey) return;
  currentKey = k;
  const mySeq = ++seq;
  if (!key || k == null) { currentPalette = null; publishSwatches(null, null); paint(); return; }
  let palette: ArtPalette | null = null;
  let swatches: Awaited<ReturnType<Awaited<ReturnType<typeof getCore>>["getArtSwatches"]>> = null;
  try {
    const core = await getCore();
    // Swatches first: a miss fetches the image once and fills the palette cache too, so the
    // palette call that follows is a cache hit (one small image per track change, never two).
    swatches = await core.getArtSwatches(key).catch(() => null);
    if (mySeq !== seq) return;
    palette = "artId" in key ? await core.getArtPalette(key.artId).catch(() => null) : null;
  } catch {
    palette = null; swatches = null;
  }
  if (mySeq !== seq) return;
  currentPalette = palette;
  publishSwatches(k, swatches?.swatches ?? null);
  paint();
}

export function initPalette() {
  usePlayer.subscribe((s) => void onArtChange(artKeyFor(s.queue[s.index])));
  useTheme.subscribe(() => paint());
  const s = usePlayer.getState();
  void onArtChange(artKeyFor(s.queue[s.index]));
}
