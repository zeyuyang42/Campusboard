// Keeps --accent / --ambient-* on :root in step with the playing track's artwork and the theme.
import { accentRatio, accentSurface, fitPalette, type AppliedPalette, type ArtPalette } from "@bc/core";
import { usePlayer } from "../player/store";
import { useTheme } from "./store";
import { getCore } from "../api/core";

let currentArt: number | null = null;
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
  if (!currentPalette) {
    root.removeProperty("--accent");
    root.removeProperty("--accent-text");
    root.setProperty("--ambient-1", "transparent");
    root.setProperty("--ambient-2", "transparent");
    applied = null;
    listeners.forEach((fn) => fn());
    return;
  }
  const fit = fitPalette(currentPalette, accentSurface(theme), accentRatio(theme));
  root.setProperty("--accent", fit.accent);
  root.setProperty("--accent-text", fit.accentText);
  root.setProperty("--ambient-1", fit.ambient1);
  root.setProperty("--ambient-2", fit.ambient2);
  applied = fit;
  listeners.forEach((fn) => fn());
}

async function onArtChange(artId: number | null) {
  if (artId === currentArt) return;
  currentArt = artId;
  const mySeq = ++seq;
  if (!artId) { currentPalette = null; paint(); return; }
  try {
    const p = await (await getCore()).getArtPalette(artId);
    if (mySeq !== seq) return;
    currentPalette = p;
  } catch {
    if (mySeq !== seq) return;
    currentPalette = null;
  }
  paint();
}

export function initPalette() {
  usePlayer.subscribe((s) => void onArtChange(s.queue[s.index]?.art_id ?? null));
  useTheme.subscribe(() => paint());
  const s = usePlayer.getState();
  void onArtChange(s.queue[s.index]?.art_id ?? null);
}
