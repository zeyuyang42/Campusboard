import { useState } from "react";
import { getCore } from "../api/core";
import { usePlayer } from "../player/store";
import { PauseIcon, PlayIcon } from "./Icons";

/** Only the latest Play click starts playback, whichever page answers first. */
let latest = 0;

/**
 * Play a search or Browse result without importing it: core.previewRelease reads the release
 * page once (page cache) and the whole release plays from its featured track, or the library
 * album plays when it is already imported (no request). Nothing is fetched before the click.
 */
export function useReleasePreview(url: string, albumId: number | null) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const current = usePlayer((s) => {
    const t = s.queue[s.index];
    if (!t) return false;
    return albumId != null && t.album_id === albumId ? true : t.preview?.item_url === url || (!!t.album_url && t.album_url === url);
  });
  const playing = usePlayer((s) => current && (s.wantsPlay || s.status === "playing"));
  const play = async () => {
    if (current) { usePlayer.getState().toggle(); return; }
    const mine = ++latest;
    setBusy(true);
    setError(null);
    try {
      const r = await (await getCore()).previewRelease(url);
      if (mine === latest) usePlayer.getState().playTracks(r.tracks, r.start);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return { play, busy, error, current, playing };
}

/** The play button for a release; `className` picks the look ("icon-btn" in a row, "play" over art). */
export function ReleasePlayButton({ title, preview, className }: { title: string; preview: ReturnType<typeof useReleasePreview>; className: string }) {
  const { play, busy, playing, current } = preview;
  const label = `${playing ? "Pause" : "Play"} ${title}`;
  return (
    <button
      className={`${className} ${current ? "shown" : ""} ${busy ? "busy" : ""}`}
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); if (!busy) void play(); }}
      onKeyDown={(e) => e.stopPropagation()}
      aria-busy={busy || undefined}
      title={busy ? "Loading from Bandcamp…" : label}
      aria-label={label}
    >
      {playing ? <PauseIcon size={20} /> : <PlayIcon size={20} />}
    </button>
  );
}
