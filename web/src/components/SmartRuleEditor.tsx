import { useEffect, useState } from "react";
import { normalizePlaylistName, PLAYLIST_NAME_MAX, repos } from "@bc/core";
import { useSmartCount, useTags } from "../api/queries";
import { plural, SHOW_LABELS, SORT_LABELS } from "../lib/bulkPlay";
import { friendlyError } from "../lib/errors";

type Played = "any" | "within" | "not";

/** A new smart playlist starts with this track limit (editable), so a broad rule doesn't load the whole library. */
export const SMART_DEFAULT_LIMIT = 500;
/** The live count waits this long after the last change. */
export const SMART_COUNT_DEBOUNCE_MS = 250;

/** `value`, but only after it has stopped changing for `ms` (compared as JSON). */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  const key = JSON.stringify(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ms]);
  return v;
}

interface Draft {
  name: string;
  show: repos.AlbumFilter;
  minRating: number;
  tag: string;
  text: string;
  played: Played;
  days: string;
  sort: repos.AlbumSort;
  limit: string;
}

function draftOf(rule: repos.SmartRule | null, name: string | null): Draft {
  const r = rule ?? repos.parseSmartRule({})!;
  return {
    name: name ?? "",
    show: r.show,
    minRating: r.minRating,
    tag: r.tag ?? "",
    text: r.text ?? "",
    played: r.playedWithinDays ? "within" : r.notPlayedWithinDays ? "not" : "any",
    days: String(r.playedWithinDays ?? r.notPlayedWithinDays ?? 30),
    sort: r.sort,
    limit: r.limit ? String(r.limit) : rule ? "" : String(SMART_DEFAULT_LIMIT),
  };
}

/** The draft as a rule, or null while a field is out of bounds. */
export function ruleOf(d: Draft): repos.SmartRule | null {
  const days = Number(d.days);
  const limit = d.limit.trim() ? Number(d.limit) : undefined;
  return repos.parseSmartRule({
    show: d.show,
    minRating: d.minRating,
    tag: d.tag,
    text: d.text,
    ...(d.played === "within" ? { playedWithinDays: days } : d.played === "not" ? { notPlayedWithinDays: days } : {}),
    sort: d.sort,
    ...(limit !== undefined ? { limit } : {}),
  });
}

/**
 * The inline rule editor for a smart playlist (#84): plain selects and inputs, a live count of
 * matching tracks, Save and Cancel. With `name` it also edits the name (a new playlist).
 */
export function SmartRuleEditor({ rule, name, saveLabel, onSave, onCancel }: {
  rule: repos.SmartRule | null;
  /** The name field's starting value; null leaves the name out (editing an existing playlist's rule). */
  name: string | null;
  saveLabel: string;
  onSave: (rule: repos.SmartRule, name: string | null) => Promise<unknown>;
  onCancel: () => void;
}) {
  const [d, setD] = useState(() => draftOf(rule, name));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: tags } = useTags("all");
  const r = ruleOf(d);
  const cleanName = name === null ? null : normalizePlaylistName(d.name);
  const count = useSmartCount(useDebounced(r, SMART_COUNT_DEBOUNCE_MS));
  const set = (p: Partial<Draft>) => { setD((x) => ({ ...x, ...p })); setError(null); };
  const ok = !!r && (name === null || !!cleanName);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!r || !ok || busy) return;
    setBusy(true);
    try {
      await onSave(r, cleanName);
    } catch (err) {
      setError(friendlyError(err, "Couldn't save the smart playlist."));
    } finally {
      setBusy(false);
    }
  };
  const tagMissing = d.tag && !(tags ?? []).some((t) => t.tag.toLowerCase() === d.tag.toLowerCase());

  return (
    <form className="smart-editor" onSubmit={submit} onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }} aria-label="Smart playlist rule">
      {name !== null && (
        <label className="field wide">
          <span>Name</span>
          <input autoFocus placeholder="Smart playlist name" maxLength={PLAYLIST_NAME_MAX} value={d.name} onChange={(e) => set({ name: e.target.value })} />
        </label>
      )}
      <label className="field">
        <span>Show</span>
        <select value={d.show} onChange={(e) => set({ show: e.target.value as repos.AlbumFilter })}>
          {(Object.keys(SHOW_LABELS) as repos.AlbumFilter[]).map((f) => <option key={f} value={f}>{SHOW_LABELS[f]}</option>)}
        </select>
      </label>
      <label className="field">
        <span>Rating</span>
        <select value={d.minRating} onChange={(e) => set({ minRating: Number(e.target.value) })}>
          <option value={0}>Any rating</option>
          {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n === 5 ? "★★★★★" : `${"★".repeat(n)} or more`}</option>)}
        </select>
      </label>
      <label className="field">
        <span>Tag</span>
        <select value={d.tag} onChange={(e) => set({ tag: e.target.value })}>
          <option value="">Any tag</option>
          {tagMissing && <option value={d.tag}>{d.tag}</option>}
          {(tags ?? []).map((t) => <option key={t.tag} value={t.tag}>{t.tag}</option>)}
        </select>
      </label>
      <label className="field">
        <span>Text</span>
        <input placeholder="Album, artist or track" maxLength={repos.SMART_TEXT_MAX} value={d.text} onChange={(e) => set({ text: e.target.value })} />
      </label>
      <div className="field">
        <label htmlFor="smart-played">Played</label>
        <span className="inline">
          <select id="smart-played" value={d.played} onChange={(e) => set({ played: e.target.value as Played })}>
            <option value="any">Any time</option>
            <option value="within">In the last</option>
            <option value="not">Not in the last</option>
          </select>
          {d.played !== "any" && (
            <>
              <input type="number" min={1} max={repos.SMART_DAYS_MAX} step={1} value={d.days} onChange={(e) => set({ days: e.target.value })} aria-label="Days" style={{ width: 72 }} />
              <span className="muted">days</span>
            </>
          )}
        </span>
      </div>
      <label className="field">
        <span>Sort</span>
        <select value={d.sort} onChange={(e) => set({ sort: e.target.value as repos.AlbumSort })}>
          {repos.ALBUM_SORTS.map((s) => <option key={s} value={s}>{SORT_LABELS[s]}</option>)}
        </select>
      </label>
      <label className="field">
        <span>Limit</span>
        <input type="number" min={1} max={repos.SMART_LIMIT_MAX} step={1} placeholder="No limit" value={d.limit} onChange={(e) => set({ limit: e.target.value })} aria-label="Limit (tracks)" style={{ width: 96 }} />
      </label>
      <div className="smart-actions">
        <span className="muted" role="status">
          {!r ? `Days go from 1 to ${repos.SMART_DAYS_MAX.toLocaleString()}, the limit from 1 to ${repos.SMART_LIMIT_MAX.toLocaleString()} tracks.` : count.data === undefined ? "Counting…" : `${plural(count.data, "track")} match`}
        </span>
        <button className="btn primary" type="submit" disabled={!ok || busy}>{saveLabel}</button>
        <button className="btn" type="button" onClick={onCancel}>Cancel</button>
        {error && <span className="error" role="alert">{error}</span>}
      </div>
    </form>
  );
}
