import { radioQueueTrack, type RadioShowSummary } from "@bc/core";
import { useRadioShows } from "../api/queries";
import { usePlayer } from "../player/store";
import { useUi } from "../ui/store";
import { ArtImage } from "../components/ArtImage";
import { PlayIcon } from "../components/Icons";
import { friendlyError } from "../lib/errors";
import { formatReleaseDate } from "../lib/format";

/** Bandcamp Radio (#44): the latest episodes. Playing one queues it as a single long track. */
export function RadioPage() {
  const { data: shows, isLoading, error } = useRadioShows();
  if (error) return <div className="notice error">Couldn't load Bandcamp Radio. {friendlyError(error)}</div>;
  if (isLoading || !shows) return <div className="empty">Loading…</div>;
  return (
    <>
      <h1 className="page-title">Radio</h1>
      <p className="muted radio-intro">
        Bandcamp's own shows, each an hour or two of music with the releases it plays. Open Now playing during a show to see what's on and import it.
      </p>
      {shows.length === 0 ? <div className="empty">No episodes listed right now.</div> : (
        <div className="grid">{shows.map((s) => <RadioCard key={s.id} show={s} />)}</div>
      )}
    </>
  );
}

function RadioCard({ show }: { show: RadioShowSummary }) {
  const playing = usePlayer((s) => s.queue[s.index]?.radio?.show_id === show.id);
  const play = () => {
    const p = usePlayer.getState();
    if (playing) { p.play(); return; }
    p.playTracks([radioQueueTrack(show)]);
    useUi.getState().setNowPlayingOpen(true);
  };
  const enqueue = () => usePlayer.getState().enqueueLast([radioQueueTrack(show)]);
  return (
    <div className={`card radio-card ${playing ? "current" : ""}`}>
      <div className="art">
        <ArtImage artId={null} imageId={show.image_id} size={16} alt="" />
        <button className="play" onClick={play} title={`Play ${show.title}`} aria-label={`Play ${show.title}`}><PlayIcon size={20} /></button>
      </div>
      <div className="title selectable" title={show.title}>{show.title}</div>
      <div className="sub">{show.program}</div>
      {show.date && <div className="sub">{formatReleaseDate(show.date)}</div>}
      {show.description && <p className="radio-desc selectable">{show.description}</p>}
      <div className="release-actions">
        <button className="btn sm" onClick={enqueue}>Add to queue</button>
      </div>
    </div>
  );
}
