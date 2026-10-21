import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { friendlyError } from "../lib/errors";
import { CROSSFADE_MAX_SEC, PRESETS, parseThemeJson, type Theme } from "@bc/core";
import { usePlayer } from "../player/store";
import { useTheme } from "../theme/store";
import { appVersion, pickBackgroundImage, pickTextFile, saveTextFile } from "../lib/files";
import { exportLibraryFile } from "../lib/libraryFile";
import { isTauri } from "../lib/env";
import { AccountSettings } from "../components/AccountSettings";
import { LibrarySettings } from "../components/LibrarySettings";
import { ConfirmButton } from "../components/ConfirmButton";
import { useClearHistory, useOfflineMutations, useOfflineStats, usePlayCount, useReleaseCheckStatus, useReleaseMutations } from "../api/queries";
import { formatBytes, formatPlays } from "../lib/format";
import { useMenuBar } from "../lib/menuBar";
import { useTrackNotifications } from "../lib/notifications";

const SHORTCUTS: [string, string][] = [
  ["Space", "Play or pause"], ["← →", "Seek 5 seconds"], ["⇧← ⇧→", "Previous or next track"], ["↑ ↓", "Volume"],
  ["S", "Shuffle"], ["R", "Repeat"], ["Q", "Queue"], ["N", "Now playing"], ["/", "Search"], ["Esc", "Close a panel"],
  ["⌘P", "Play or pause"], ["⌘← ⌘→", "Previous or next track"], ["⌘↑ ⌘↓", "Volume"], ["⌘⇧S  ⌘⇧R", "Shuffle, repeat"],
  ["⌘⇧N  ⌘⇧Q", "Now playing, queue"], ["⌘⇧M", "Mini player"], ["⌘1 – ⌘4", "Library, Search, Import, Playlists"], ["⌘[ ⌘]", "Back, forward"],
  ["⌘K", "Command palette"], ["⌘F", "Find"], ["⌘I", "Import from link"], ["⌘N", "New playlist"], ["⌘,", "Settings"],
  ["⌘W", "Close the window (music keeps playing)"], ["⌘Q", "Quit"], ["⌃⌘F", "Full screen"],
];

const FONT_SUGGESTIONS = ["Bricolage Grotesque Variable", "Instrument Sans Variable", "Helvetica Neue", "Avenir Next", "Georgia", "Iowan Old Style", "Menlo", "SF Mono"];

export function SettingsPage() {
  const { theme, resolved, basePreset, update, replace, applyPreset, reset } = useTheme();
  // Following the system, a preset applies its side for the current appearance: show that one.
  const swatch = (p: Theme) => (theme.mode === "system" ? (resolved.mode === "dark" ? p.paletteDark : p.paletteLight) : undefined) ?? p.palette;
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => { void appVersion().then(setVersion); }, []);
  useEffect(() => { if (!notice) return; const t = setTimeout(() => setNotice(null), 4000); return () => clearTimeout(t); }, [notice]);

  const exportTheme = async () => {
    const ok = await saveTextFile(`${theme.name.replace(/[^A-Za-z0-9-_ ]/g, "")}.theme.json`, JSON.stringify(theme, null, 2), { name: "Theme", extensions: ["json"] });
    if (ok) setNotice({ kind: "ok", text: "Theme exported." });
  };
  const importTheme = async () => {
    const f = await pickTextFile({ name: "Theme", extensions: ["json"] });
    if (!f) return;
    const r = parseThemeJson(f.text);
    if (!r.theme) { setNotice({ kind: "error", text: `Couldn't import ${f.name}: ${r.error}` }); return; }
    replace(r.theme, r.theme.name);
    setNotice({ kind: "ok", text: `Imported "${r.theme.name}".` });
  };
  const chooseBackground = async () => {
    const name = await pickBackgroundImage();
    if (name) update({ background: { source: "file", value: name } });
  };

  return (
    <div className="settings">
      <h1 className="page-title">Settings</h1>
      {notice && <div className={`notice ${notice.kind}`}>{notice.text}</div>}

      <AccountSettings />

      <NewReleaseSettings />

      <PlaybackSettings />

      <BackgroundSettings />

      <ListeningHistory />

      <StorageSettings />

      <LibrarySettings />

      <section id="theme">
        <h2>Theme</h2>
        <p className="muted">Start from a preset, then adjust anything below. Changes apply as you make them.</p>
        <div className="chips">
          {PRESETS.map((p) => (
            <button key={p.name} className={`chip ${basePreset === p.name ? "on" : ""}`} onClick={() => applyPreset(p.name)}>
              <span className="swatch" style={{ background: swatch(p).surface, borderColor: swatch(p).accent }} />
              {p.name}
            </button>
          ))}
        </div>
        <div className="field-row">
          <label>Theme name <input value={theme.name} maxLength={40} onChange={(e) => update({ name: e.target.value })} /></label>
          <label>Base
            <select value={theme.mode} onChange={(e) => update({ mode: e.target.value as Theme["mode"] })}>
              <option value="system">Match system</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </label>
        </div>
      </section>

      <section>
        <h2>Colors</h2>
        <div className="colors">
          {(
            [
              ["surface", "Background"],
              ["surfaceRaised", "Raised surfaces"],
              ["text", "Text"],
              ["textMuted", "Secondary text"],
              ["accent", "Accent when nothing is playing"],
              ["danger", "Remove and delete"],
            ] as [keyof Theme["palette"], string][]
          ).map(([key, label]) => (
            <ColorField key={key} label={label} value={resolved.palette[key]} onChange={(v) => update({ palette: { [key]: v } })} />
          ))}
        </div>
      </section>

      <section>
        <h2>Shape and density</h2>
        <div className="field-row">
          <label>Corner radius <span className="muted">{theme.radius}px</span>
            <input type="range" min={0} max={24} step={1} value={theme.radius} onChange={(e) => update({ radius: Number(e.target.value) })} />
          </label>
          <label>Rows
            <div className="segmented">
              {(["comfortable", "compact"] as const).map((d) => (
                <button key={d} className={theme.density === d ? "on" : ""} onClick={() => update({ density: d })}>{d === "comfortable" ? "Comfortable" : "Compact"}</button>
              ))}
            </div>
          </label>
        </div>
      </section>

      <section>
        <h2>Type</h2>
        <p className="muted">Any font installed on this Mac works. Unknown names fall back to the bundled faces.</p>
        <datalist id="font-suggestions">{FONT_SUGGESTIONS.map((f) => <option key={f} value={f} />)}</datalist>
        <div className="field-row">
          <label>Titles <input list="font-suggestions" value={theme.fonts.display} onChange={(e) => update({ fonts: { display: e.target.value } })} />
            <span className="sample display">Let Me Do One More</span>
          </label>
          <label>Everything else <input list="font-suggestions" value={theme.fonts.ui} onChange={(e) => update({ fonts: { ui: e.target.value } })} />
            <span className="sample ui">12 tracks, 41 minutes, released October 2021</span>
          </label>
        </div>
      </section>

      <section>
        <h2>Backdrop</h2>
        <div className="field-row">
          <label>Mode
            <div className="segmented">
              {([["conservative", "Conservative"], ["wash", "Ambient wash"], ["morph", "Generative"]] as const).map(([m, label]) => (
                <button key={m} className={theme.backdrop.mode === m ? "on" : ""} onClick={() => update({ backdrop: { mode: m } })}>{label}</button>
              ))}
            </div>
          </label>
          {theme.backdrop.mode === "morph" && (
            <label>Style
              <select value={theme.backdrop.style} onChange={(e) => update({ backdrop: { style: e.target.value as Theme["backdrop"]["style"] } })}>
                <option value="ink">Fluid ink</option>
                <option value="aurora">Aurora curtains</option>
                <option value="glitch">Glitch</option>
                <option value="lava">Lava blobs</option>
              </select>
            </label>
          )}
          {theme.backdrop.mode !== "conservative" && (
            <label>Motion
              <div className="segmented">
                {([["drift", "Drift"], ["still", "Still"]] as const).map(([m, label]) => (
                  <button key={m} className={theme.backdrop.motion === m ? "on" : ""} onClick={() => update({ backdrop: { motion: m } })}>{label}</button>
                ))}
              </div>
            </label>
          )}
        </div>
        <div className="field-row">
          {theme.backdrop.mode === "conservative" ? (
            <label>Album-art wash <span className="muted">{Math.round(theme.ambient * 100)}%</span>
              <input type="range" min={0} max={1} step={0.05} value={theme.ambient} onChange={(e) => update({ ambient: Number(e.target.value) })} />
            </label>
          ) : (
            <label>Intensity <span className="muted">{Math.round(theme.backdrop.intensity * 100)}%</span>
              <input type="range" min={0} max={1} step={0.05} value={theme.backdrop.intensity} onChange={(e) => update({ backdrop: { intensity: Number(e.target.value) } })} />
            </label>
          )}
          <label>Background image
            <select value={theme.background.source} onChange={(e) => update({ background: { source: e.target.value as Theme["background"]["source"], value: e.target.value === "none" ? "" : theme.background.value } })}>
              <option value="none">None</option>
              <option value="url">Image URL</option>
              {isTauri && <option value="file">Image file</option>}
            </select>
          </label>
        </div>
        {theme.background.source === "url" && (
          <label>Image URL (https) <input placeholder="https://…/image.jpg" value={theme.background.value} onChange={(e) => update({ background: { value: e.target.value } })} /></label>
        )}
        {theme.background.source === "file" && (
          <div className="row"><button className="btn" onClick={chooseBackground}>Choose image…</button><span className="muted">{theme.background.value || "No image chosen"}</span></div>
        )}
        {theme.background.source !== "none" && (
          <div className="field-row">
            <label>Blur <span className="muted">{theme.background.blur}px</span><input type="range" min={0} max={40} step={1} value={theme.background.blur} onChange={(e) => update({ background: { blur: Number(e.target.value) } })} /></label>
            <label>Dim <span className="muted">{Math.round(theme.background.dim * 100)}%</span><input type="range" min={0} max={1} step={0.05} value={theme.background.dim} onChange={(e) => update({ background: { dim: Number(e.target.value) } })} /></label>
          </div>
        )}
      </section>

      <section>
        <h2>Theme file</h2>
        <p className="muted">Share a theme as a small JSON file. Importing replaces the current theme.</p>
        <div className="row">
          <button className="btn" onClick={exportTheme}>Export theme…</button>
          <button className="btn" onClick={importTheme}>Import theme…</button>
          <button className="btn" onClick={reset}>Reset to {basePreset}</button>
        </div>
      </section>

      <section id="shortcuts">
        <h2>Keyboard shortcuts</h2>
        <div className="shortcuts">
          {SHORTCUTS.map(([keys, what]) => <div key={keys} className="shortcut"><span>{what}</span><kbd>{keys}</kbd></div>)}
        </div>
      </section>

      <section>
        <h2>About</h2>
        <p className="muted">Version {version ?? "…"}</p>
        <AboutExport />
      </section>
    </div>
  );
}

/**
 * Settings → About: save the library as a file wherever the user picks. Replaces "Open data
 * folder", whose openPath was refused (opener:default has no allow-open-path) and which sent
 * people into Application Support. The export carries listening history (Library has the option).
 */
function AboutExport() {
  const [state, setState] = useState<{ kind: "busy" | "ok" | "error"; text?: string } | null>(null);
  const run = async () => {
    setState({ kind: "busy" });
    try {
      setState(await exportLibraryFile({ history: true }) ? { kind: "ok", text: "Library exported." } : null);
    } catch (e) {
      setState({ kind: "error", text: `Couldn't export the library. ${friendlyError(e, e instanceof Error && e.message ? e.message : "")}`.trim() });
    }
  };
  return (
    <>
      <p className="muted">Your library is kept inside the app. Export it to keep a copy or to move it to another Mac; <Link to="/settings#library">Library</Link> above can import it again or back up the whole database.</p>
      <div className="row">
        <button className="btn" disabled={state?.kind === "busy"} onClick={() => void run()}>{state?.kind === "busy" ? "Exporting…" : "Export library…"}</button>
      </div>
      {state?.text && <div className={`notice ${state.kind}`}>{state.text}</div>}
    </>
  );
}

const STOPPED: Record<string, string> = {
  job: "Paused while an import runs.",
  cooldown: "Paused: Bandcamp asked us to slow down.",
  off: "Checking is turned off.",
  busy: "A check is already running.",
};

function NewReleaseSettings() {
  const { data: status } = useReleaseCheckStatus();
  const { setEnabled, checkNow } = useReleaseMutations();
  // One pass at a time: a second click (before the button re-renders disabled) is ignored,
  // so its immediate "busy" answer can't replace the real pass's result.
  const inFlight = useRef(false);
  const [result, setResult] = useState<{ checked: number; found: number; stopped: string | null } | null>(null);
  const running = !!status?.running || checkNow.isPending;
  const runCheck = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setResult(null);
    checkNow.mutate(undefined, {
      onSuccess: (r) => { if (r.stopped !== "busy") setResult(r); },
      onSettled: () => { inFlight.current = false; },
    });
  };
  const last = status?.last_check_at ? new Date(status.last_check_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : null;
  return (
    <section id="releases">
      <h2>New releases</h2>
      <p className="muted">
        While the app is open it looks at one artist from your library every few minutes, each at most once a day,
        and lists releases that appear after that artist's first look under New releases. It waits while imports run.
      </p>
      <label className="check-row">
        <input type="checkbox" checked={setEnabled.isPending ? setEnabled.variables : (status?.enabled ?? true)} disabled={!status || setEnabled.isPending} onChange={(e) => setEnabled.mutate(e.target.checked)} />
        Check for new releases
      </label>
      <div className="row">
        <button className="btn" disabled={!status?.enabled || running || !status.artists} onClick={runCheck}>{running ? "Checking…" : "Check now"}</button>
        <span className="muted">
          {last ? `Last checked ${last}.` : "Not checked yet."}
          {status && status.muted > 0 ? ` ${status.muted} artist${status.muted === 1 ? "" : "s"} muted.` : ""}
        </span>
      </div>
      {result && !running && (
        <p className="muted">
          {result.stopped && STOPPED[result.stopped] ? `${STOPPED[result.stopped]} ` : ""}
          Checked {result.checked} artist{result.checked === 1 ? "" : "s"}{result.found ? `, found ${result.found} new` : ", nothing new"}.
        </p>
      )}
      {checkNow.error && <div className="notice error">Couldn't check. {friendlyError(checkNow.error)}</div>}
    </section>
  );
}

function ListeningHistory() {
  const { data: n } = usePlayCount();
  const clear = useClearHistory();
  return (
    <section id="history">
      <h2>Listening history</h2>
      <p className="muted">
        A track counts as played once you have listened to half of it or four minutes, whichever comes first.
        History is stored in your local library and feeds Recently played, Most played and the History tab in the Library. Radio episodes are not recorded.
      </p>
      <div className="row">
        {n ? (
          <>
            <span>{formatPlays(n)} recorded</span>
            <Link className="btn" to="/library/history">Show history</Link>
            <ConfirmButton label="Clear listening history" confirmLabel="Clear history" question={n === 1 ? "Forget the 1 play?" : `Forget all ${n} plays?`} onConfirm={() => clear.mutateAsync().then(() => undefined)} />
          </>
        ) : <span className="muted">Nothing recorded yet.</span>}
      </div>
      {clear.error && <div className="notice error">Couldn't clear the history. {String((clear.error as Error).message ?? clear.error)}</div>}
    </section>
  );
}

const CAP_CHOICES_MB = [1000, 2000, 5000, 10_000, 20_000, 50_000];

/** Settings > Storage: offline copies (#2), their size, a size limit and Remove all. */
function StorageSettings() {
  const { data: stats } = useOfflineStats();
  const { removeAll, setCap } = useOfflineMutations();
  if (!stats?.available) return null;
  const cap = setCap.isPending ? setCap.variables : stats.cap_mb;
  const choices = cap != null && !CAP_CHOICES_MB.includes(cap) ? [...CAP_CHOICES_MB, cap].sort((a, b) => a - b) : CAP_CHOICES_MB;
  return (
    <section id="storage">
      <h2>Storage</h2>
      <p className="muted">
        Albums you make available offline keep a copy of the same stream the player uses, so they play without a
        connection and after Bandcamp's links expire. They are for listening in this app only and are not purchases:
        buy on Bandcamp to own a release. Downloads stay on this Mac and are left out of library exports.
      </p>
      <div className="row">
        <span>{stats.tracks ? `${formatBytes(stats.bytes)} in ${stats.tracks} track${stats.tracks === 1 ? "" : "s"} from ${stats.albums} album${stats.albums === 1 ? "" : "s"}` : "Nothing downloaded yet."}</span>
        {stats.tracks > 0 && (
          <ConfirmButton label="Remove all downloads" confirmLabel="Remove all" question={`Remove ${formatBytes(stats.bytes)} of downloads?`} onConfirm={() => removeAll.mutateAsync().then(() => undefined)} />
        )}
      </div>
      <div className="row">
        <label className="muted" htmlFor="offline-cap">Limit downloads to</label>
        <select id="offline-cap" value={cap ?? ""} onChange={(e) => setCap.mutate(e.target.value ? Number(e.target.value) : null)}>
          <option value="">No limit</option>
          {choices.map((mb) => <option key={mb} value={mb}>{formatBytes(mb * 1e6)}</option>)}
        </select>
      </div>
      {cap != null && stats.bytes >= cap * 1e6 && <p className="muted">The limit is reached: new downloads stop until you remove some or raise it.</p>}
      {(removeAll.error || setCap.error) && <div className="notice error">{friendlyError(removeAll.error ?? setCap.error)}</div>}
    </section>
  );
}

function PlaybackSettings() {
  const gapless = usePlayer((s) => s.gapless);
  const crossfadeSec = usePlayer((s) => s.crossfadeSec);
  const setPlayback = usePlayer((s) => s.setPlayback);
  return (
    <section id="playback">
      <h2>Playback</h2>
      <p className="muted">
        The next track loads in the background shortly before the current one ends. Crossfade only applies
        between different albums, so an album's own transitions always play as recorded.
      </p>
      <label className="check-row">
        <input type="checkbox" checked={gapless} onChange={(e) => setPlayback({ gapless: e.target.checked })} />
        Gapless playback
      </label>
      <div className="field-row">
        <label>Crossfade <span className="muted">{crossfadeSec > 0 ? `${crossfadeSec} s` : "Off"}</span>
          <input type="range" min={0} max={CROSSFADE_MAX_SEC} step={1} value={crossfadeSec} onChange={(e) => setPlayback({ crossfadeSec: Number(e.target.value) })} />
        </label>
      </div>
    </section>
  );
}

/** Things the app does while its window is closed. Desktop app only. */
function BackgroundSettings() {
  const menuBar = useMenuBar();
  const notify = useTrackNotifications();
  if (!isTauri) return null;
  return (
    <section id="background">
      <h2>When the window is closed</h2>
      <p className="muted">Music keeps playing after you close the window. These help you follow and control it from elsewhere.</p>
      <label className="check-row">
        <input type="checkbox" checked={menuBar.enabled} onChange={(e) => menuBar.setEnabled(e.target.checked)} />
        Show playback controls in the menu bar
      </label>
      <label className="check-row">
        <input type="checkbox" checked={notify.enabled} onChange={(e) => void notify.setEnabled(e.target.checked)} />
        Show a notification when the track changes
      </label>
      {notify.denied && <p className="muted">Notifications are turned off for Campusboard in System Settings → Notifications.</p>}
    </section>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = (v: string) => {
    setText(v);
    if (/^#[0-9a-fA-F]{6}$/.test(v)) onChange(v);
  };
  return (
    <label className="color-field">
      <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(text) ? text : value} onChange={(e) => commit(e.target.value)} />
      <span>{label}</span>
      <input className="hex" value={text} maxLength={7} spellCheck={false} onChange={(e) => commit(e.target.value.startsWith("#") ? e.target.value : `#${e.target.value}`)} />
    </label>
  );
}
