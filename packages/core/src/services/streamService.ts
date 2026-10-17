import type { Db } from "../db/Db.js";
import { getTrackRow } from "../db/repos/tracks.js";
import type { FetchQueue } from "../scrape/http.js";
import { parseTralbumPage } from "../scrape/parseTralbum.js";
import { ScrapeError } from "../scrape/errors.js";
import { upsertTralbum } from "./importService.js";
import { identityHeaders } from "./account.js";
import { ownedFetchUrl } from "../db/repos/fanItems.js";
import { STREAM_SAFETY_MS } from "../config.js";

const inflight = new Map<number, Promise<void>>();

/**
 * Re-scrape an album page and refresh every track's stream URL. Deduped per album.
 * A purchased album is fetched from its name.bandcamp.com address with the identity
 * cookie when one is set, so its tracks come back as mp3-v0.
 */
export function refreshAlbum(db: Db, queue: FetchQueue, albumId: number, url: string): Promise<void> {
  let p = inflight.get(albumId);
  if (!p) {
    p = (async () => {
      const owned = await ownedFetchUrl(db, albumId);
      const headers = owned ? await identityHeaders(db, owned) : {};
      const html = await queue.fetchText(headers.Cookie ? owned! : url, { headers });
      await upsertTralbum(db, parseTralbumPage(html));
    })().finally(() => inflight.delete(albumId));
    inflight.set(albumId, p);
  }
  return p;
}

export async function getFreshStreamUrl(db: Db, queue: FetchQueue, trackId: number, force = false): Promise<{ url: string; expires_at: number }> {
  let t = await getTrackRow(db, trackId);
  if (!t) throw new ScrapeError("not_found", `Track ${trackId} not found`);
  if (!t.streamable) throw new ScrapeError("not_streamable", `"${t.title}" is not streamable on Bandcamp`);
  const fresh = t.stream_url && t.stream_expires_at && t.stream_expires_at - Date.now() > STREAM_SAFETY_MS;
  if (!force && fresh) return { url: t.stream_url!, expires_at: t.stream_expires_at! };

  await refreshAlbum(db, queue, t.album_id, t.album_url);
  t = await getTrackRow(db, trackId);
  if (!t?.stream_url) throw new ScrapeError("not_streamable", "Stream URL unavailable after refresh");
  return { url: t.stream_url, expires_at: t.stream_expires_at ?? Date.now() };
}
