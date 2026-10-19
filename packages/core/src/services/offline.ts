import type { Db } from "../db/Db.js";
import { getTrackRow } from "../db/repos/tracks.js";
import { getSetting, setSetting } from "../db/repos/settings.js";
import type { FetchQueue } from "../scrape/http.js";
import { ScrapeError } from "../scrape/errors.js";
import { getFreshStreamUrl } from "./streamService.js";
import { OFFLINE_SETTING_KEY } from "../config.js";
import type { OfflineStats } from "../types.js";

/**
 * Offline copies of library tracks (#2). Personal use: a copy is the same 128 kbps stream the
 * player would play (mp3-v0 for a purchase synced with the cookie), kept so playback survives
 * an expired URL or no network. It is not a purchase, and the album page keeps its Buy link.
 *
 * Files live in one folder per library database (the app gives its path, see lib.rs
 * `offline_dir`), named `<Bandcamp track id>.mp3`; `tracks.local_path` holds that name and
 * `track_files` its size. Everything here goes through the injected OfflineFiles, so core
 * never touches a path itself and tests run on an in-memory folder.
 */
export interface OfflineFiles {
  /** Write `body` to `name` in the offline folder as it arrives, replacing any file of that name. */
  write(name: string, body: ReadableStream<Uint8Array>): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Remove `name`; a missing file is not an error. */
  remove(name: string): Promise<void>;
  exists(name: string): Promise<boolean>;
  /** The names of the files in the folder. */
  list(): Promise<string[]>;
  /** A URL an <audio> element can play the file from. */
  url(name: string): string | Promise<string>;
}

const FILE_NAME = /^\d+\.mp3$/;
const PART_NAME = /^\d+\.mp3\.part$/;

/** The offline file of a Bandcamp track id. */
export const offlineFileName = (bandcampTrackId: number) => `${Math.trunc(bandcampTrackId)}.mp3`;
/** Only names this module makes are ever passed to OfflineFiles (a database value can't name another path). */
export const isOfflineFileName = (name: unknown): name is string => typeof name === "string" && FILE_NAME.test(name);

/** Job item URL of one track of a download job: the album URL plus the track. */
export const downloadItemUrl = (albumUrl: string, bandcampTrackId: number) => `${albumUrl}#track=${bandcampTrackId}`;
export function downloadItemTrack(url: string): number | null {
  const m = url.match(/#track=(\d+)$/);
  return m ? Number(m[1]) : null;
}

const MB = 1_000_000;

export interface OfflineSettings { cap_mb: number | null }

export class OfflineService {
  /** Names being written or finalised right now; the sweep leaves them alone. */
  private busy = new Set<string>();
  /** Finalising a download, removals and the sweep run one at a time. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private db: Db, private queue: FetchQueue, private files: OfflineFiles | null) {}

  get available(): boolean { return !!this.files; }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private need(): OfflineFiles {
    if (!this.files) throw new ScrapeError("offline_unavailable", "Offline copies aren't available here");
    return this.files;
  }

  async settings(): Promise<OfflineSettings> {
    const s = await getSetting<Partial<OfflineSettings>>(this.db, OFFLINE_SETTING_KEY);
    const cap = typeof s?.cap_mb === "number" && Number.isFinite(s.cap_mb) && s.cap_mb > 0 ? Math.round(s.cap_mb) : null;
    return { cap_mb: cap };
  }

  /** The size limit in MB (decimal, as Finder counts), or null for none. */
  async setCap(capMb: number | null): Promise<void> {
    const cap = capMb != null && Number.isFinite(capMb) && capMb > 0 ? Math.min(Math.round(capMb), 10_000_000) : null;
    await setSetting(this.db, OFFLINE_SETTING_KEY, { cap_mb: cap });
  }

  async stats(): Promise<OfflineStats> {
    const r = await this.db.get<{ tracks: number; albums: number; bytes: number }>(
      `SELECT COUNT(*) AS tracks, COUNT(DISTINCT t.album_id) AS albums, COALESCE(SUM(f.bytes), 0) AS bytes
       FROM tracks t JOIN track_files f ON f.track_id = t.id WHERE t.local_path IS NOT NULL`,
    );
    return { tracks: r?.tracks ?? 0, albums: r?.albums ?? 0, bytes: r?.bytes ?? 0, cap_mb: (await this.settings()).cap_mb, available: this.available };
  }

  /** True when the size limit is set and the saved copies already reach it. */
  async capReached(): Promise<boolean> {
    const s = await this.stats();
    return s.cap_mb != null && s.bytes >= s.cap_mb * MB;
  }

  /**
   * A playable URL for the track's offline copy, or null when it has none. A copy whose file
   * went missing is forgotten here, so the player streams instead.
   */
  async localUrl(trackId: number): Promise<string | null> {
    if (!this.files) return null;
    const r = await this.db.get<{ local_path: string | null }>("SELECT local_path FROM tracks WHERE id = ?", [trackId]);
    const name = r?.local_path;
    if (!isOfflineFileName(name)) return null;
    if (!(await this.files.exists(name))) {
      await this.forget([trackId]);
      return null;
    }
    return this.files.url(name);
  }

  /**
   * Save one library track's stream to the offline folder: "have" if it already has a copy,
   * "saved" once the file and its rows are written. The stream URL comes from
   * getFreshStreamUrl (an album page refresh through the queue when it's stale), the mp3
   * through FetchQueue.download. A CDN that refuses the URL (expired, 4xx) gets one retry
   * with a freshly scraped URL. The file is written as `<name>.part` and renamed when
   * complete, so a cut-off download never looks like a copy.
   */
  async download(trackId: number): Promise<"have" | "saved"> {
    const files = this.need();
    const row = await getTrackRow(this.db, trackId);
    if (!row) throw new ScrapeError("not_found", `Track ${trackId} is no longer in the library`);
    const current = row.local_path;
    if (isOfflineFileName(current) && (await files.exists(current))) return "have";
    if (!row.streamable) throw new ScrapeError("not_streamable", `"${row.title}" is not streamable on Bandcamp`);
    const name = offlineFileName(row.track_id);
    const part = `${name}.part`;
    this.busy.add(part);
    this.busy.add(name);
    try {
      let bytes = 0;
      for (let attempt = 0; ; attempt++) {
        const { url } = await getFreshStreamUrl(this.db, this.queue, trackId, attempt > 0);
        try {
          bytes = await this.queue.download(url, (body) => files.write(part, body));
          break;
        } catch (e) {
          const status = e instanceof ScrapeError ? (e.detail as { status?: number } | undefined)?.status : undefined;
          if (attempt === 0 && status != null && status >= 400 && status < 500) continue;
          throw e;
        }
      }
      if (bytes < 1024) throw new ScrapeError("fetch_failed", `The download of "${row.title}" was empty`);
      const quality = (await this.db.get<{ q: string }>("SELECT stream_quality AS q FROM tracks WHERE id = ?", [trackId]))?.q ?? "mp3-128";
      await this.exclusive(async () => {
        await files.rename(part, name);
        try {
          // Fails (foreign key) if the album was removed while this track downloaded.
          await this.db.run(
            `INSERT INTO track_files (track_id, bytes, quality) VALUES (?, ?, ?)
             ON CONFLICT(track_id) DO UPDATE SET bytes = excluded.bytes, quality = excluded.quality, saved_at = datetime('now')`,
            [trackId, bytes, quality],
          );
          const r = await this.db.run("UPDATE tracks SET local_path = ? WHERE id = ?", [name, trackId]);
          if (r.changes === 0) throw new ScrapeError("not_found", `Track ${trackId} is no longer in the library`);
        } catch (e) {
          await files.remove(name).catch(() => undefined);
          throw e;
        }
      });
      return "saved";
    } catch (e) {
      await files.remove(part).catch(() => undefined);
      throw e;
    } finally {
      this.busy.delete(part);
      this.busy.delete(name);
    }
  }

  /** Clear the rows of tracks whose file is gone (no file removed). */
  private async forget(trackIds: number[]): Promise<void> {
    if (!trackIds.length) return;
    const marks = trackIds.map(() => "?").join(",");
    await this.db.run(`UPDATE tracks SET local_path = NULL WHERE id IN (${marks})`, trackIds);
    await this.db.run(`DELETE FROM track_files WHERE track_id IN (${marks})`, trackIds);
  }

  /** Remove the offline copies of these tracks: rows first, files last. Returns how many there were. */
  async remove(trackIds: number[]): Promise<number> {
    if (!trackIds.length) return 0;
    return this.exclusive(async () => {
      const rows: { id: number; local_path: string | null }[] = [];
      for (let i = 0; i < trackIds.length; i += 500) {
        const chunk = trackIds.slice(i, i + 500);
        rows.push(...await this.db.select<{ id: number; local_path: string | null }>(
          `SELECT id, local_path FROM tracks WHERE local_path IS NOT NULL AND id IN (${chunk.map(() => "?").join(",")})`, chunk));
      }
      for (let i = 0; i < rows.length; i += 500) await this.forget(rows.slice(i, i + 500).map((r) => r.id));
      if (this.files) for (const r of rows) if (isOfflineFileName(r.local_path)) await this.files.remove(r.local_path).catch(() => undefined);
      return rows.length;
    });
  }

  async removeAlbum(albumId: number): Promise<number> {
    const ids = (await this.db.select<{ id: number }>("SELECT id FROM tracks WHERE album_id = ? AND local_path IS NOT NULL", [albumId])).map((r) => r.id);
    return this.remove(ids);
  }

  /** Remove every offline copy, then sweep the folder of anything left. */
  async removeAll(): Promise<number> {
    const ids = (await this.db.select<{ id: number }>("SELECT id FROM tracks WHERE local_path IS NOT NULL")).map((r) => r.id);
    const n = await this.remove(ids);
    await this.sweep();
    return n;
  }

  /**
   * Make the folder and the rows agree, idempotently: forget copies whose file is gone, drop
   * size rows without a copy, and remove files no track names (a removed album's, or one
   * left by an interrupted download). Files being written now are left alone. Returns how
   * many files it removed.
   */
  async sweep(): Promise<number> {
    const files = this.files;
    if (!files) return 0;
    return this.exclusive(async () => {
      const names = new Set(await files.list());
      const rows = await this.db.select<{ id: number; local_path: string }>("SELECT id, local_path FROM tracks WHERE local_path IS NOT NULL");
      const missing = rows.filter((r) => !isOfflineFileName(r.local_path) || !names.has(r.local_path)).map((r) => r.id);
      for (let i = 0; i < missing.length; i += 500) await this.forget(missing.slice(i, i + 500));
      await this.db.run("DELETE FROM track_files WHERE track_id NOT IN (SELECT id FROM tracks WHERE local_path IS NOT NULL)");
      const kept = new Set(rows.map((r) => r.local_path));
      let removed = 0;
      for (const n of names) {
        if (this.busy.has(n) || kept.has(n) || !(FILE_NAME.test(n) || PART_NAME.test(n))) continue;
        await files.remove(n).catch(() => undefined);
        removed++;
      }
      return removed;
    });
  }
}
