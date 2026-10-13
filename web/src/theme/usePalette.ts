// Keeps --accent / --ambient-* on :root in step with the playing track's artwork and the theme.
import { fitPalette, type ArtPalette } from "@bc/core";
import { usePlayer } from "../player/store";
import { useTheme } from "./store";
import { getCore } from "../api/core";

let currentArt: number | null = null;
let currentPalette: ArtPalette | null = null;
let seq = 0;

function paint() {
  const root = document.documentElement.style;
  const { theme } = useTheme.getState();
  if (!currentPalette) {
    root.removeProperty("--accent");
    root.removeProperty("--accent-text");
    root.setProperty("--ambient-1", "transparent");
    root.setProperty("--ambient-2", "transparent");
    return;
  }
  const fit = fitPalette(currentPalette, theme.palette.surface, 3);
  root.setProperty("--accent", fit.accent);
  root.setProperty("--accent-text", fit.accentText);
  root.setProperty("--ambient-1", fit.ambient1);
  root.setProperty("--ambient-2", fit.ambient2);
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
