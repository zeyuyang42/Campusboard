import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { HistoryEntry, Track } from "@bc/core";
import { keys, usePlayHistory } from "../api/queries";
import { getCore } from "../api/core";
import { usePlayer } from "../player/store";
import { useTrackActions } from "../lib/useTrackActions";
import { groupByDay, playedTime } from "../lib/history";
import { friendlyError } from "../lib/errors";
import { openMenuFromEvent } from "../ui/menu";
import { ArtImage } from "./ArtImage";
import { MoreIcon } from "./Icons";

/** The library track behind a history row, without the play's own fields (they'd ride into the queue). */
const toTrack = ({ play_id: _p, played_at: _a, ...t }: HistoryEntry): Track => t;

/**
 * The Library's History tab (#86): counted plays newest first, grouped by local day, a page at
 * a time. Radio episodes aren't library tracks and are never recorded, so they don't show.
 */
export function PlayHistory() {
  const { data, isLoading, error, hasNextPage, fetchNextPage, isFetchingNextPage } = usePlayHistory();
  const qc = useQueryClient();
  const currentId = usePlayer((s) => s.queue[s.index]?.id);
  const playTracks = usePlayer((s) => s.playTracks);
  const toggle = usePlayer((s) => s.toggle);
  const actions = useTrackActions();

  if (error) return <div className="notice error">Couldn't load your listening history. {friendlyError(error)}</div>;
  if (isLoading) return <div className="empty">Loading…</div>;
  const entries = data?.pages.flatMap((p) => p.entries) ?? [];
  if (!entries.length) {
    return <div className="empty">Nothing played yet. Tracks show up here once you've listened to half of one, or four minutes.</div>;
  }

  // In its album's context: the album's playable tracks, starting at this one.
  const play = async (e: HistoryEntry) => {
    if (e.id === currentId) return toggle();
    if (!e.streamable) return;
    const album = await qc.fetchQuery({ queryKey: keys.album(e.album_id), queryFn: async () => (await getCore()).album(e.album_id) }).catch(() => null);
    const playable = album?.tracks.filter((t) => t.streamable) ?? [];
    const i = playable.findIndex((t) => t.id === e.id);
    if (i < 0) playTracks([toTrack(e)]); else playTracks(playable, i);
  };
  // A click that ends a text selection isn't a play.
  const onRowClick = (e: HistoryEntry) => { if (!window.getSelection()?.toString()) void play(e); };

  return (
    <div className="history">
      {groupByDay(entries).map((day) => (
        <section key={day.key} aria-label={day.label}>
          <h2>{day.label}</h2>
          <ul>
            {day.entries.map((e) => (
              <li
                key={e.play_id}
                className={`${e.id === currentId ? "current" : ""} ${e.streamable ? "" : "disabled"}`}
                onClick={() => onRowClick(e)}
                onContextMenu={(ev) => openMenuFromEvent(ev, actions([toTrack(e)]))}
              >
                <button className="art" onClick={(ev) => { ev.stopPropagation(); void play(e); }} aria-label={`Play ${e.title}`} title="Play" disabled={!e.streamable}>
                  <ArtImage artId={e.art_id} size={7} alt="" />
                </button>
                <div className="t">
                  <div className="title selectable">{e.title}</div>
                  <div className="sub selectable">{e.track_artist ?? e.artist_name}</div>
                </div>
                <Link className="album selectable" to={`/album/${e.album_id}`} onClick={(ev) => ev.stopPropagation()}>{e.album_title}</Link>
                <time className="when" dateTime={`${e.played_at.replace(" ", "T")}Z`}>{playedTime(e.played_at)}</time>
                <button className="icon-btn" title="More" aria-label={`More actions for ${e.title}`} onClick={(ev) => { ev.stopPropagation(); openMenuFromEvent(ev, actions([toTrack(e)])); }}><MoreIcon /></button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {hasNextPage && (
        <button className="btn show-more" disabled={isFetchingNextPage} onClick={() => void fetchNextPage()}>
          {isFetchingNextPage ? "Loading…" : "Show more"}
        </button>
      )}
    </div>
  );
}
