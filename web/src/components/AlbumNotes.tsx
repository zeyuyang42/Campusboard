import { useEffect, useRef, useState } from "react";
import { repos } from "@bc/core";
import { useAlbumNote, useAlbumNoteWriter } from "../api/queries";
import { friendlyError } from "../lib/errors";

/** How long typing pauses before the note is saved (it is also saved on blur). */
export const NOTE_SAVE_DELAY_MS = 800;

/**
 * Your 0-5 star rating (#73). One focusable slider: arrow keys step it, 1-5 set it, 0,
 * Backspace or Delete clear it. A click on a star sets it, and a click on the current
 * rating clears it. Filled and outline stars, so the rating shows by shape, not only by colour.
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
        <span key={n} className={n <= shown ? "star on" : "star"} aria-hidden="true" onMouseEnter={() => setHover(n)} onClick={() => onChange(n === value ? 0 : n)}>{n <= shown ? "★" : "☆"}</span>
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
  /** The newest note the database (or the cache) gave, and how many of our saves are in flight. */
  const incoming = useRef(initial);
  const inFlight = useRef(0);
  /**
   * Take the newest note when nothing typed here is unsaved and no save of ours is on its way
   * (a refetch made before that save lands would be older). Focused or not: with no unsaved
   * edits, keeping the old text would only let the next keystroke save it over the newer note.
   */
  const adopt = () => {
    if (inFlight.current || latest.current !== saved.current || incoming.current === latest.current) return;
    setText(incoming.current);
    latest.current = saved.current = incoming.current;
  };
  const save = () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const note = latest.current;
    if (note === saved.current) return;
    saved.current = note;
    inFlight.current++;
    onSave(note)
      .then(() => setError(null), (e: unknown) => { saved.current = null; setError(e); })
      .finally(() => { inFlight.current--; adopt(); });
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => () => saveRef.current(), []); // leaving the page saves what was typed
  // Fresher data (a refetch, an imported library) replaces the text when that loses nothing.
  useEffect(() => { incoming.current = initial; adopt(); }, [initial]);
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
  const { setRating, setNote } = useAlbumNoteWriter(albumId);
  const [ratingError, setRatingError] = useState<unknown>(null);
  if (!isSuccess) return null;
  // The stars show the cache, which a save updates at once and a failed one puts back.
  return (
    <div className="album-notes">
      <StarRating value={data?.rating ?? 0} onChange={(r) => { setRatingError(null); setRating(r).catch(setRatingError); }} />
      {ratingError != null && <span className="muted rating-error" role="alert">Couldn't save the rating. {friendlyError(ratingError)}</span>}
      <NoteEditor key={albumId} initial={data?.note ?? ""} onSave={setNote} />
    </div>
  );
}
