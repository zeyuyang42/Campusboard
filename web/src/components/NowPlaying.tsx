import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { usePlayer } from "../player/store";
import { useTrackLyrics } from "../api/queries";
import { useUi } from "../ui/store";
import { ArtImage } from "./ArtImage";
import { QueueList } from "./QueueList";
import { CloseIcon } from "./Icons";

/** Full-window view of the current track: big art, details, queue and lyrics. The dock stays as transport. */
export function NowPlaying() {
  const cur = usePlayer((s) => s.queue[s.index] ?? null);
  const close = useUi((s) => s.setNowPlayingOpen);
  const [tab, setTab] = useState<"queue" | "lyrics">("queue");
  const { data: lyrics } = useTrackLyrics(tab === "lyrics" ? cur?.id ?? null : null);
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
        <ArtImage className="np-art" artId={cur.art_id} size={10} alt="" />
        <h1 className="np-title">{cur.title}</h1>
        <div className="np-sub">
          <span>{cur.track_artist ?? cur.artist_name}</span>
          <Link to={`/album/${cur.album_id}`} onClick={() => close(false)}>{cur.album_title}</Link>
        </div>
      </div>
      <div className="np-right">
        <div className="segmented">
          <button className={tab === "queue" ? "on" : ""} onClick={() => setTab("queue")}>Queue</button>
          <button className={tab === "lyrics" ? "on" : ""} onClick={() => setTab("lyrics")}>Lyrics</button>
        </div>
        <div className="np-panel">
          {tab === "queue" ? <QueueList /> : lyrics ? <pre className="lyrics">{lyrics}</pre> : <div className="empty">No lyrics for this track.</div>}
        </div>
      </div>
    </section>
  );
}
