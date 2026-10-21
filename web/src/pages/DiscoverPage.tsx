import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  DISCOVER_MAX_TAGS, DISCOVER_SLICES, DISCOVER_TIMES, discoverParamsFromQuery, discoverQuery, discoverWebUrl, parseDiscoverUrl,
  previewQueueTrack, type DiscoverItem, type DiscoverParams, type DiscoverSetup, type QueueTrack,
} from "@bc/core";
import { getCore } from "../api/core";
import { useDiscover, useDiscoverLocations, useDiscoverTags, useImport, useInvalidateLibrary, useJob } from "../api/queries";
import { usePlayer } from "../player/store";
import { ArtImage } from "../components/ArtImage";
import { ExternalLink } from "../components/ExternalLink";
import { CloseIcon, ExternalIcon, PauseIcon, PlayIcon } from "../components/Icons";
import { JobProgress } from "../components/JobProgress";
import { ChallengeNotice } from "../components/ChallengeNotice";
import { friendlyError } from "../lib/errors";

/** The last setup, restored when /discover opens without a query (#104). */
export const DISCOVER_SETTING_KEY = "discover_last";

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

/** A saved setup as a query string, validated the same way as a link's. */
export function setupQuery(s: unknown): string | null {
  if (!s || typeof s !== "object") return null;
  const o = s as Partial<DiscoverSetup>;
  const q = new URLSearchParams();
  if (Array.isArray(o.tags)) q.set("tags", o.tags.filter((t) => typeof t === "string").join(","));
  if (typeof o.slice === "string") q.set("s", o.slice);
  if (typeof o.time === "number") q.set("t", String(o.time));
  if (typeof o.location === "number") q.set("loc", String(o.location));
  const p = discoverParamsFromQuery(q);
  const label = p.location && typeof o.location_label === "string" ? o.location_label.slice(0, 120) : null;
  return withLabel(discoverQuery(p), label);
}
const withLabel = (query: string, label: string | null) => (label ? `${query}&locname=${encodeURIComponent(label)}` : query);

/** Bandcamp's discover in the app: filters, the results grid, previews of each featured track. */
export function DiscoverPage() {
  const [search, setSearch] = useSearchParams();
  const empty = search.toString() === "";
  // No query: the last setup (or the defaults) replaces it, once read.
  useEffect(() => {
    if (!empty) return;
    let live = true;
    void getCore().then((c) => c.getSetting<DiscoverSetup>(DISCOVER_SETTING_KEY)).catch(() => null).then((s) => {
      if (live) setSearch(setupQuery(s) ?? "s=top", { replace: true });
    });
    return () => { live = false; };
  }, [empty]); // eslint-disable-line react-hooks/exhaustive-deps

  const params = useMemo(() => discoverParamsFromQuery(search), [search]);
  const locLabel = params.location ? search.get("locname") : null;
  const update = (p: DiscoverParams, label: string | null = p.location === params.location ? locLabel : null) =>
    setSearch(withLabel(discoverQuery(p), p.location ? label : null), { replace: true });

  // Every change is the new "last setup".
  const key = search.toString();
  useEffect(() => {
    if (empty) return;
    const setup: DiscoverSetup = { ...params, location_label: locLabel };
    void getCore().then((c) => c.setSetting(DISCOVER_SETTING_KEY, setup)).catch(() => undefined);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (empty) return null;
  return (
    <>
      <div className="page-title">
        <span>Discover</span>
        <Total params={params} />
        <span className="actions">
          <ExternalLink className="btn" href={discoverWebUrl(params)}>Open on Bandcamp <ExternalIcon /></ExternalLink>
        </span>
      </div>
      <div className="discover-filters">
        <TagInput tags={params.tags} onChange={(tags) => update({ ...params, tags })} onLink={(p) => update(p, null)} />
        <div className="toolbar">
          <div className="segmented" role="group" aria-label="Sort">
            {DISCOVER_SLICES.map((s) => (
              <button key={s.slug} className={params.slice === s.slug ? "on" : ""} aria-pressed={params.slice === s.slug} onClick={() => update({ ...params, slice: s.slug })}>{s.label}</button>
            ))}
          </div>
          <select aria-label="Released" value={params.time ?? -1} onChange={(e) => { const t = Number(e.target.value); update({ ...params, time: t >= 0 ? t : null }); }}>
            {DISCOVER_TIMES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
          <LocationInput id={params.location} label={locLabel} onChange={(id, label) => update({ ...params, location: id }, label)} />
        </div>
      </div>
      <Results params={params} />
    </>
  );
}

function Total({ params }: { params: DiscoverParams }) {
  const { data } = useDiscover(params);
  const total = data?.pages[0]?.total;
  if (total == null) return null;
  return <span className="count">{total.toLocaleString()} release{total === 1 ? "" : "s"}</span>;
}

function Results({ params }: { params: DiscoverParams }) {
  const { data, error, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage, refetch } = useDiscover(params);
  const items = useMemo(() => {
    const seen = new Set<string>();
    return (data?.pages ?? []).flatMap((p) => p.items).filter((i) => (seen.has(i.url) ? false : (seen.add(i.url), true)));
  }, [data]);
  const playable = useMemo(() => items.map(previewQueueTrack).filter((t): t is QueueTrack => !!t), [items]);
  if (error && !data) return <><div className="notice error">Couldn't load Discover. {friendlyError(error)} <button className="btn sm" onClick={() => void refetch()}>Try again</button></div><ChallengeNotice /></>;
  if (isLoading || !data) return <div className="empty">Loading releases from Bandcamp…</div>;
  if (!items.length) return <div className="empty">Nothing on Bandcamp matches these filters. Try fewer tags or another time.</div>;
  return (
    <>
      <div className="toolbar">
        <button className="btn primary" disabled={!playable.length} onClick={() => usePlayer.getState().playTracks(playable)}><PlayIcon size={16} /> Play all</button>
        <span className="muted discover-hint">Plays each release's featured track. Add brings the whole release into your library.</span>
      </div>
      <div className="grid discover-grid">
        {items.map((i) => <DiscoverCard key={i.url} item={i} />)}
      </div>
      {error && <div className="notice error" style={{ marginTop: 16 }}>Couldn't load more. {friendlyError(error)}</div>}
      {hasNextPage && (
        <div className="discover-more">
          <button className="btn" disabled={isFetchingNextPage} onClick={() => void fetchNextPage()}>{isFetchingNextPage ? "Loading…" : "Show more"}</button>
        </div>
      )}
    </>
  );
}

function DiscoverCard({ item }: { item: DiscoverItem }) {
  const trackId = item.featured?.track_id ?? null;
  const current = usePlayer((s) => trackId != null && s.queue[s.index]?.preview?.track_id === trackId);
  const playing = usePlayer((s) => current && (s.wantsPlay || s.status === "playing"));
  const imp = useImport();
  const [jobId, setJobId] = useState<number | null>(null);
  const { data: job } = useJob(jobId);
  const invalidate = useInvalidateLibrary();
  const finished = job?.status === "done" || job?.status === "failed";
  useEffect(() => { if (finished) invalidate(); }, [finished]); // eslint-disable-line react-hooks/exhaustive-deps
  const albumId = item.album_id ?? (job?.status === "done" ? job.items?.find((x) => x.album_id)?.album_id ?? null : null);
  const busy = imp.isPending || (!!job && !finished);
  const play = () => {
    const p = usePlayer.getState();
    if (current) { p.toggle(); return; }
    const t = previewQueueTrack(item);
    if (t) p.playTracks([t]);
  };
  const add = async () => { const j = await imp.mutateAsync({ url: item.url }); setJobId(j.id); };
  const label = item.featured ? `${playing ? "Pause" : "Play"} “${item.featured.title}”` : "";
  return (
    <div className={`card discover-card ${current ? "current" : ""}`}>
      <div className={`art ${item.featured ? "playable" : ""}`} onClick={item.featured ? play : undefined}>
        <ArtImage artId={item.art_id} size={16} alt="" />
        {item.preorder && <span className="badge">pre-order</span>}
        {item.featured && (
          <button className={`play ${current ? "shown" : ""}`} onClick={(e) => { e.stopPropagation(); play(); }} title={label} aria-label={label}>
            {playing ? <PauseIcon size={20} /> : <PlayIcon size={20} />}
          </button>
        )}
      </div>
      <ExternalLink className="title selectable" href={item.url} title={`${item.title} on Bandcamp`}>{item.title}</ExternalLink>
      <div className="sub">
        {item.artist_url ? <Link to={`/browse?url=${encodeURIComponent(item.artist_url)}`} title={`${item.artist}'s releases`}>{item.artist}</Link> : item.artist}
      </div>
      <div className="release-actions">
        {albumId ? <Link className="btn sm" to={`/album/${albumId}`}>In library</Link>
          : <button className="btn sm" onClick={() => void add().catch(() => undefined)} disabled={busy}>{busy ? "Adding…" : "Add"}</button>}
      </div>
      {job && job.status !== "done" && <JobProgress job={job} compact />}
    </div>
  );
}

/** A small suggestion list under a text field; ↑/↓ and Enter pick, Escape closes. */
function useSuggestions<T>(list: T[], open: boolean) {
  const [hi, setHi] = useState(0);
  useEffect(() => setHi(0), [list, open]);
  const key = (e: React.KeyboardEvent, pick: (t: T) => void): boolean => {
    if (!open || !list.length) return false;
    if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => (h + 1) % list.length); return true; }
    if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => (h - 1 + list.length) % list.length); return true; }
    if (e.key === "Enter" && list[hi]) { e.preventDefault(); pick(list[hi]); return true; }
    return false;
  };
  return { hi, setHi, key };
}

function TagInput({ tags, onChange, onLink }: { tags: string[]; onChange: (tags: string[]) => void; onLink: (p: DiscoverParams) => void }) {
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const typed = text.trim().toLowerCase();
  const prefix = useDebounced(typed, 300);
  const { data, isFetching } = useDiscoverTags(prefix);
  // Only the answer for what is typed now: an older prefix's list is never shown.
  const list = useMemo(() => (prefix === typed ? (data ?? []).filter((t) => !tags.includes(t.norm_name)).slice(0, 8) : []), [data, prefix, typed, tags]);
  const open = focused && typed.length >= 2 && list.length > 0;
  const add = (norm: string) => {
    const n = norm.trim().toLowerCase().replace(/\s+/g, "-");
    if (n && !tags.includes(n) && tags.length < DISCOVER_MAX_TAGS) onChange([...tags, n]);
    setText("");
  };
  const s = useSuggestions(list, open);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="discover-tags" onClick={() => input.current?.focus()}>
      {tags.map((t) => (
        <span className="chip tag-chip" key={t}>
          <span className="selectable">{t.replace(/-/g, " ")}</span>
          <button className="icon-btn" title={`Remove ${t}`} aria-label={`Remove ${t}`} onClick={(e) => { e.stopPropagation(); onChange(tags.filter((x) => x !== t)); }}><CloseIcon size={14} /></button>
        </span>
      ))}
      <div className="suggest-wrap">
        <input
          ref={input}
          aria-label="Add a tag"
          placeholder={tags.length ? "Add a tag" : "Tags, e.g. electronic, glitch"}
          disabled={tags.length >= DISCOVER_MAX_TAGS}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onPaste={(e) => {
            const p = parseDiscoverUrl(e.clipboardData.getData("text/plain"));
            if (p) { e.preventDefault(); setText(""); onLink(p); }
          }}
          onKeyDown={(e) => {
            if (s.key(e, (t) => add(t.norm_name))) return;
            if (e.key === "Enter" && typed) { e.preventDefault(); add(typed); }
            else if (e.key === "Backspace" && !text && tags.length) onChange(tags.slice(0, -1));
            else if (e.key === "Escape") setText("");
          }}
        />
        {open && (
          <ul className="suggest" role="listbox">
            {list.map((t, i) => (
              <li key={t.norm_name} role="option" aria-selected={i === s.hi} className={i === s.hi ? "on" : ""}
                onMouseEnter={() => s.setHi(i)} onMouseDown={(e) => { e.preventDefault(); add(t.norm_name); }}>
                <span>{t.display_name}</span><span className="muted">{t.count.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
        {focused && typed.length >= 2 && isFetching && !list.length && <div className="suggest-note muted">Looking up tags…</div>}
      </div>
    </div>
  );
}

function LocationInput({ id, label, onChange }: { id: number | null; label: string | null; onChange: (id: number | null, label: string | null) => void }) {
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const typed = text.trim().toLowerCase();
  const q = useDebounced(typed, 300);
  const { data } = useDiscoverLocations(q);
  const list = useMemo(() => (q === typed ? data ?? [] : []), [data, q, typed]);
  const open = focused && typed.length >= 3 && list.length > 0;
  const s = useSuggestions(list, open);
  const pick = (l: { id: number; label: string }) => { onChange(l.id, l.label); setText(""); };
  if (id) {
    return (
      <span className="chip tag-chip location-chip">
        <span className="selectable" title={label ?? undefined}>{label ?? `Place ${id}`}</span>
        <button className="icon-btn" title="Anywhere" aria-label="Clear location" onClick={() => onChange(null, null)}><CloseIcon size={14} /></button>
      </span>
    );
  }
  return (
    <div className="suggest-wrap">
      <input
        className="location-input"
        aria-label="Location"
        placeholder="From anywhere"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => { if (!s.key(e, pick) && e.key === "Escape") setText(""); }}
      />
      {open && (
        <ul className="suggest" role="listbox">
          {list.map((l, i) => (
            <li key={l.id} role="option" aria-selected={i === s.hi} className={i === s.hi ? "on" : ""}
              onMouseEnter={() => s.setHi(i)} onMouseDown={(e) => { e.preventDefault(); pick(l); }}>
              <span>{l.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
