import { useEffect, useRef, useState } from "react";
import { repos } from "@bc/core";
import { useAlbumNote, useAlbumNoteMutations } from "../api/queries";
import { friendlyError } from "../lib/errors";

/** How long typing pauses before the note is saved (it is also saved on blur). */
export const NOTE_SAVE_DELAY_MS = 800;

/**
 * Your 0-5 star rating (#73). One focusable slider: arrow keys step it, 1-5 set it, 0,
 * Backspace or Delete clear it. A click on a star sets it, and a click on the current
 * rating clears it.
 */
export function StarRating({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover ?? value;
  const set = (v: number) => { const r = Math.max(0, Math.min(repos.RATING_MAX, v)); if (r !== value) onChange(r); };
  const onKeyDown = (e: React.KeyboardEvent) => {
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = value + 1;
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = value - 1;
    else if (e.key === "Home" || e.key === "0" || e.key === "Backspace" || e.key === "Delete") next = 0;
    else if (e.key === "End") next = repos.RATING_MAX;
    else if (/^[1-5]$/.test(e.key)) next = Number(e.key);
    if (next === null) return;
    // Not the player's arrow-key seek and volume shortcuts.
    e.preventDefault();
    e.stopPropagation();
    set(next);
  };
  return (
    <div
      className="stars" role="slider" tabIndex={0} aria-label="Your rating" aria-valuemin={0} aria-valuemax={repos.RATING_MAX} aria-valuenow={value}
      aria-valuetext={value ? `${value} of ${repos.RATING_MAX} stars` : "Not rated"} title={value ? `${value} of ${repos.RATING_MAX} stars, click it again to clear` : "Rate this album"}
      onKeyDown={onKeyDown} onMouseLeave={() => setHover(null)}
    >
      {Array.from({ length: repos.RATING_MAX }, (_, i) => i + 1).map((n) => (
        <span key={n} className={n <= shown ? "star on" : "star"} aria-hidden="true" onMouseEnter={() => setHover(n)} onClick={() => onChange(n === value ? 0 : n)}>★</span>
      ))}
    </div>
  );
}

/**
 * The album's note: plain text, saved a moment after typing stops, on blur, and when the
 * page goes away. At most repos.NOTE_MAX characters.
 */
export function NoteEditor({ initial, onSave }: { initial: string; onSave: (note: string) => Promise<unknown> }) {
  const [text, setText] = useState(initial);
  const [error, setError] = useState<unknown>(null);
  const saved = useRef<string | null>(initial); // null after a failed save, so the next one retries
  const latest = useRef(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const save = () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const note = latest.current;
    if (note === saved.current) return;
    saved.current = note;
    onSave(note).then(() => setError(null), (e: unknown) => { saved.current = null; setError(e); });
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => () => saveRef.current(), []); // leaving the page saves what was typed
  const left = repos.NOTE_MAX - text.length;
  return (
    <div className="album-note">
      <textarea
        className="selectable" aria-label="Your note" placeholder="Add a note" rows={2} maxLength={repos.NOTE_MAX} value={text}
        onChange={(e) => {
          setText(e.target.value);
          latest.current = e.target.value;
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => saveRef.current(), NOTE_SAVE_DELAY_MS);
        }}
        onBlur={() => save()}
      />
      {left < 200 && <span className="muted note-count">{left} characters left</span>}
      {error != null && <span className="notice error">Couldn't save your note. {friendlyError(error)}</span>}
    </div>
  );
}

/** The album page's rating and note (#73). */
export function AlbumNotes({ albumId }: { albumId: number }) {
  const { data, isSuccess } = useAlbumNote(albumId);
  const { setRating, setNote } = useAlbumNoteMutations(albumId);
  const [rating, setRatingShown] = useState<number | null>(null);
  if (!isSuccess) return null;
  return (
    <div className="album-notes">
      <StarRating value={rating ?? data?.rating ?? 0} onChange={(r) => { setRatingShown(r); setRating.mutate(r); }} />
      <NoteEditor key={albumId} initial={data?.note ?? ""} onSave={(note) => setNote.mutateAsync(note)} />
    </div>
  );
}
