import type { Db } from "../db/connection.js";
import { getTrackRow } from "../db/repos/tracks.js";
import { fetchQueue, parseTralbumPage, ScrapeError } from "../scrape/index.js";
import { upsertTralbum } from "./importService.js";
import { STREAM_SAFETY_MS } from "../config.js";

const inflight = new Map<number, Promise<void>>();

/** Re-scrape an album page and refresh every track's stream URL. Deduped per album. */
export function refreshAlbum(db: Db, albumId: number, url: string): Promise<void> {
  let p = inflight.get(albumId);
  if (!p) {
    p = (async () => {
      const html = await fetchQueue.fetchText(url);
      upsertTralbum(db, parseTralbumPage(html));
    })().finally(() => inflight.delete(albumId));
    inflight.set(albumId, p);
  }
  return p;
}

export async function getFreshStreamUrl(db: Db, trackId: number, force = false): Promise<{ url: string; expires_at: number }> {
  let t = getTrackRow(db, trackId);
  if (!t) throw new ScrapeError("not_found", `Track ${trackId} not found`);
  if (!t.streamable) throw new ScrapeError("not_streamable", `"${t.title}" is not streamable on Bandcamp`);
  const fresh = t.stream_url && t.stream_expires_at && t.stream_expires_at - Date.now() > STREAM_SAFETY_MS;
  if (!force && fresh) return { url: t.stream_url!, expires_at: t.stream_expires_at! };

  await refreshAlbum(db, t.album_id, t.album_url);
  t = getTrackRow(db, trackId);
  if (!t?.stream_url) throw new ScrapeError("not_streamable", "Stream URL unavailable after refresh");
  return { url: t.stream_url, expires_at: t.stream_expires_at ?? Date.now() };
}
