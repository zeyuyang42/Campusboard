import { useRef, useState } from "react";
import { formatDuration } from "../lib/format";

/**
 * A scrubbable progress bar: elapsed, bar, total. Presentational only (no store, no bus): the
 * player bar binds it to the store, the mini window to its command channel. While the pointer is
 * down the bar follows it and `onSeek` fires once on release.
 */
export function Seek({ position, duration, onSeek, className, totalLabel, testId }: {
  position: number;
  duration: number;
  onSeek: (sec: number) => void;
  className: string;
  /** The right-hand label; defaults to the (normalised) duration. */
  totalLabel?: string;
  testId?: string;
}) {
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
    <div className={className}>
      <span>{formatDuration(shown)}</span>
      <div
        className="bar"
        ref={bar}
        data-testid={testId}
        onPointerDown={(e) => { if (!dur) return; (e.target as HTMLElement).setPointerCapture(e.pointerId); setScrub(fromEvent(e)); }}
        onPointerMove={(e) => { if (scrub !== null) setScrub(fromEvent(e)); }}
        onPointerUp={(e) => { if (scrub !== null) { onSeek(fromEvent(e)); setScrub(null); } }}
      >
        <div className="track"><div className="fill" style={{ width: `${pct}%` }} /></div>
      </div>
      <span>{totalLabel ?? formatDuration(dur)}</span>
    </div>
  );
}
