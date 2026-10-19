import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { usePlayer } from "../player/store";
import { useTrackLyrics } from "../api/queries";
import { useUi } from "../ui/store";
import { ArtImage } from "./ArtImage";
import { QueueList } from "./QueueList";
import { RadioTracklist } from "./RadioTracklist";
import { useRadioNow } from "../player/radio";
import { CloseIcon } from "./Icons";

/** Full-window view of the current track: big art, details, queue and lyrics. The dock stays as transport. */
export function NowPlaying() {
  const cur = usePlayer((s) => s.queue[s.index] ?? null);
  const close = useUi((s) => s.setNowPlayingOpen);
  const [tab, setTab] = useState<"default" | "queue" | "lyrics" | "tracklist">("default");
  const radio = !!cur?.radio;
  // A radio episode has a tracklist instead of lyrics, and opens on it.
  const shown = radio ? (tab === "queue" ? "queue" : "tracklist") : tab === "lyrics" ? "lyrics" : "queue";
  const { entry } = useRadioNow(radio ? cur : null);
  const { data: lyrics, isPending: lyricsLoading } = useTrackLyrics(shown === "lyrics" ? cur?.id ?? null : null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);
  if (!cur) return null;
  return (
    <section className="now-playing" aria-label="Now playing">
      <button className="icon-btn np-close" title="Close (Esc)" onClick={() => close(false)}><CloseIcon /></button>
      <div className="np-left">
        <ArtImage className="np-art" artId={cur.art_id} imageId={cur.radio?.image_id} size={10} alt="" />
        <h1 className="np-title">{cur.title}</h1>
        {cur.radio ? (
          <>
            <div className="np-sub"><Link to="/radio" onClick={() => close(false)}>{cur.radio.program}</Link></div>
            {entry && <div className="np-featuring selectable">Now featuring {entry.artist}, “{entry.title}”</div>}
          </>
        ) : (
          <div className="np-sub">
            <span>{cur.track_artist ?? cur.artist_name}</span>
            <Link to={`/album/${cur.album_id}`} onClick={() => close(false)}>{cur.album_title}</Link>
          </div>
        )}
      </div>
      <div className="np-right">
        <div className="segmented">
          {radio && <button className={shown === "tracklist" ? "on" : ""} onClick={() => setTab("tracklist")}>Tracklist</button>}
          <button className={shown === "queue" ? "on" : ""} onClick={() => setTab("queue")}>Queue</button>
          {!radio && <button className={shown === "lyrics" ? "on" : ""} onClick={() => setTab("lyrics")}>Lyrics</button>}
        </div>
        <div className="np-panel">
          {shown === "queue" ? <QueueList />
            : shown === "tracklist" ? <RadioTracklist cur={cur} onOpenAlbum={() => close(false)} />
            : lyrics ? <pre className="lyrics">{lyrics}</pre> : lyricsLoading ? null : <div className="empty">No lyrics for this track.</div>}
        </div>
      </div>
    </section>
  );
}
