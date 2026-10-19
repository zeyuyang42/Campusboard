import { Link } from "react-router-dom";
import { formatSleepLeft, sleepChoiceOf, toggleAction, type SleepChoice } from "@bc/core";
import { usePlayer } from "../player/store";
import { ArtImage } from "./ArtImage";
import { NextIcon, PauseIcon, PlayIcon, PrevIcon, QueueIcon, RepeatIcon, RepeatOneIcon, ShuffleIcon, VolumeIcon } from "./Icons";
import { SeekBar } from "./SeekBar";
import { useUi } from "../ui/store";
import { ClockIcon, ExpandIcon, MenuIcon, MiniPlayerIcon } from "./Icons";
import { openMenuFromEvent, type MenuItem } from "../ui/menu";
import { toggleMiniPlayer } from "../player/miniBridge";
import { useRadioNow } from "../player/radio";

/** The sleep timer's choices (#70), as the clock button's menu lists them. */
function sleepMenu(radio: boolean): MenuItem[] {
  const { sleep, setSleep } = usePlayer.getState();
  const chosen = sleepChoiceOf(sleep);
  const opt = (choice: SleepChoice, label: string): MenuItem => ({ label, hint: chosen === choice ? "✓" : undefined, onSelect: () => setSleep(choice) });
  return [
    { kind: "label", label: "Sleep timer" },
    opt("off", "Off"),
    { kind: "separator" },
    opt(15, "15 minutes"), opt(30, "30 minutes"), opt(45, "45 minutes"), opt(60, "60 minutes"),
    { kind: "separator" },
    opt("track", radio ? "End of episode" : "End of track"),
    opt("album", "End of album"),
  ];
}

/** What is left on the timer, quietly, next to its button. */
function SleepLeft() {
  const sleep = usePlayer((p) => p.sleep);
  const left = usePlayer((p) => p.sleepLeft);
  if (!sleep) return null;
  const text = sleep.kind === "minutes" ? formatSleepLeft(left ?? sleep.minutes * 60) : sleep.kind === "track" ? "end of track" : "end of album";
  return <span className="sleep-left">{text}</span>;
}

export function PlayerBar() {
  const s = usePlayer();
  const cur = s.queue[s.index] ?? null;
  const { nowPlayingOpen, setNowPlayingOpen, toggleSidebar } = useUi();
  const { entry } = useRadioNow(cur?.radio ? cur : null, s.wantsPlay || s.status === "playing");
  return (
    <footer className="player">
      <div className="now">
        <button className="icon-btn menu-toggle" title="Menu" onClick={toggleSidebar}><MenuIcon /></button>
        {cur ? (
          <>
            <button className="art-btn" title="Now playing (N)" onClick={() => setNowPlayingOpen(!nowPlayingOpen)}><ArtImage artId={cur.art_id} imageId={cur.radio?.image_id} size={7} alt="" /></button>
            <div className="t">
              <div className="title" title={cur.title}>{cur.title}</div>
              {cur.radio ? (
                <div className="sub"><Link to="/radio">{cur.radio.program}</Link>{entry && <span title={`${entry.artist}, ${entry.title}`}>{entry.artist}, “{entry.title}”</span>}</div>
              ) : (
                <div className="sub"><span>{cur.track_artist ?? cur.artist_name}</span><Link to={`/album/${cur.album_id}`}>{cur.album_title}</Link></div>
              )}
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
            {/* The icon shows what the button does: Pause while buffering on the way to playing too. */}
            {toggleAction(s.status, s.wantsPlay) === "pause" ? <PauseIcon size={20} /> : <PlayIcon size={20} />}
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
          <button className="icon-btn" onClick={s.toggleMute} title="Mute"><VolumeIcon muted={s.volume === 0} /></button>
          <input type="range" min={0} max={1} step={0.01} value={s.volume} aria-label="Volume" onChange={(e) => s.setVolume(Number(e.target.value))} />
        </div>
        <SleepLeft />
        <button className={`icon-btn ${s.sleep ? "on" : ""}`} title="Sleep timer" aria-label="Sleep timer" aria-haspopup="menu" onClick={(e) => openMenuFromEvent(e, { items: sleepMenu(!!cur?.radio) })}><ClockIcon /></button>
        <button className="icon-btn" title="Mini player (⌘⇧M)" onClick={() => void toggleMiniPlayer().catch(() => undefined)}><MiniPlayerIcon /></button>
        <button className={`icon-btn ${s.queueOpen ? "on" : ""}`} title="Queue (Q)" onClick={() => s.setQueueOpen(!s.queueOpen)}><QueueIcon /></button>
        <button className={`icon-btn keep ${nowPlayingOpen ? "on" : ""}`} title="Now playing (N)" disabled={!cur} onClick={() => setNowPlayingOpen(!nowPlayingOpen)}><ExpandIcon /></button>
      </div>
      {s.error && <div className="error-pill">{s.error}</div>}
    </footer>
  );
}
