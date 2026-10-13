import { useRef, useState } from "react";
import { usePlayer } from "../player/store";
import { formatDuration } from "../lib/format";

export function SeekBar() {
  const position = usePlayer((s) => s.position);
  const duration = usePlayer((s) => s.duration);
  const seek = usePlayer((s) => s.seek);
  const bar = useRef<HTMLDivElement>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const dur = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const shown = scrub ?? position;
  const pct = dur ? Math.min(100, (shown / dur) * 100) : 0;

  const fromEvent = (e: React.PointerEvent) => {
    const r = bar.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur;
  };
  return (
    <div className="seek">
      <span>{formatDuration(shown)}</span>
      <div
        className="bar"
        ref={bar}
        onPointerDown={(e) => { if (!dur) return; (e.target as HTMLElement).setPointerCapture(e.pointerId); setScrub(fromEvent(e)); }}
        onPointerMove={(e) => { if (scrub !== null) setScrub(fromEvent(e)); }}
        onPointerUp={(e) => { if (scrub !== null) { seek(fromEvent(e)); setScrub(null); } }}
      >
        <div className="track"><div className="fill" style={{ width: `${pct}%` }} /></div>
      </div>
      <span>{formatDuration(dur)}</span>
    </div>
  );
}
