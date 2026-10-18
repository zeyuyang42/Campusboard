import { Link } from "react-router-dom";
import { usePlayer } from "../player/store";
import { ArtImage } from "./ArtImage";
import { NextIcon, PauseIcon, PlayIcon, PrevIcon, QueueIcon, RepeatIcon, RepeatOneIcon, ShuffleIcon, VolumeIcon } from "./Icons";
import { SeekBar } from "./SeekBar";
import { useUi } from "../ui/store";
import { ExpandIcon, MenuIcon, MiniPlayerIcon } from "./Icons";
import { toggleMiniPlayer } from "../player/miniBridge";

export function PlayerBar() {
  const s = usePlayer();
  const cur = s.queue[s.index] ?? null;
  const { nowPlayingOpen, setNowPlayingOpen, toggleSidebar } = useUi();
  return (
    <footer className="player">
      <div className="now">
        <button className="icon-btn menu-toggle" title="Menu" onClick={toggleSidebar}><MenuIcon /></button>
        {cur ? (
          <>
            <button className="art-btn" title="Now playing (N)" onClick={() => setNowPlayingOpen(!nowPlayingOpen)}><ArtImage artId={cur.art_id} size={7} alt="" /></button>
            <div className="t">
              <div className="title" title={cur.title}>{cur.title}</div>
              <div className="sub"><span>{cur.track_artist ?? cur.artist_name}</span><Link to={`/album/${cur.album_id}`}>{cur.album_title}</Link></div>
            </div>
          </>
        ) : (
          <div className="muted">Nothing playing</div>
        )}
      </div>
      <div className="controls">
        <div className="buttons">
          <button className={`icon-btn ${s.shuffle ? "on" : ""}`} title="Shuffle (S)" onClick={s.toggleShuffle}><ShuffleIcon /></button>
          <button className="icon-btn" title="Previous (Shift+←)" onClick={s.prev} disabled={!cur}><PrevIcon /></button>
          <button className="big" title="Play/Pause (Space)" onClick={s.toggle} disabled={!cur}>
            {s.status === "playing" ? <PauseIcon size={20} /> : <PlayIcon size={20} />}
          </button>
          <button className="icon-btn keep" title="Next (Shift+→)" onClick={() => s.next()} disabled={!cur}><NextIcon /></button>
          <button className={`icon-btn ${s.repeat !== "off" ? "on" : ""}`} title={`Repeat: ${s.repeat} (R)`} onClick={s.cycleRepeat}>
            {s.repeat === "one" ? <RepeatOneIcon /> : <RepeatIcon />}
          </button>
        </div>
        <SeekBar />
      </div>
      <div className="right">
        <div className="vol">
          <button className="icon-btn" onClick={() => s.setVolume(s.volume === 0 ? 0.8 : 0)} title="Mute"><VolumeIcon muted={s.volume === 0} /></button>
          <input type="range" min={0} max={1} step={0.02} value={s.volume} onChange={(e) => s.setVolume(Number(e.target.value))} />
        </div>
        <button className="icon-btn" title="Mini player (⌘⇧M)" onClick={() => void toggleMiniPlayer().catch(() => undefined)}><MiniPlayerIcon /></button>
        <button className={`icon-btn ${s.queueOpen ? "on" : ""}`} title="Queue (Q)" onClick={() => s.setQueueOpen(!s.queueOpen)}><QueueIcon /></button>
        <button className={`icon-btn keep ${nowPlayingOpen ? "on" : ""}`} title="Now playing (N)" disabled={!cur} onClick={() => setNowPlayingOpen(!nowPlayingOpen)}><ExpandIcon /></button>
      </div>
      {s.error && <div className="error-pill">{s.error}</div>}
    </footer>
  );
}
