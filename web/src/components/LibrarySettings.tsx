import { useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { LibraryExport, LibraryImportPreview } from "@bc/core";
import { getCore } from "../api/core";
import { usePendingImports } from "../api/queries";
import { isTauri } from "../lib/env";
import { pickTextFile } from "../lib/files";
import { backupLibraryDatabase, exportLibraryFile } from "../lib/libraryFile";
import { friendlyError } from "../lib/errors";
import { loadSavedTheme } from "../theme/store";
import { ConfirmButton } from "./ConfirmButton";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

type Status = { kind: "ok" | "error"; text: string; importing?: boolean } | null;
interface Pending { name: string; data: LibraryExport; preview: LibraryImportPreview; history: boolean; settings: boolean }

/** Settings → Library: export to a JSON file, import one, back up the database. */
export function LibrarySettings() {
  const qc = useQueryClient();
  const { data: waiting } = usePendingImports();
  const [withHistory, setWithHistory] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    setStatus(null);
    try { await fn(); } catch (e) { setStatus({ kind: "error", text: friendlyError(e, e instanceof Error && e.message ? e.message : "Something went wrong.") }); } finally { setBusy(null); }
  };

  const doExport = () => run("export", async () => {
    if (await exportLibraryFile({ history: withHistory })) setStatus({ kind: "ok", text: "Library exported." });
  });

  const chooseImport = () => run("import", async () => {
    setPending(null);
    const f = await pickTextFile({ name: "Library export", extensions: ["json"] });
    if (!f) return;
    const core = await getCore();
    const parsed = core.parseLibraryFile(f.text);
    if (!parsed.data) { setStatus({ kind: "error", text: `Couldn't import ${f.name}. ${parsed.error}` }); return; }
    const preview = await core.previewLibraryImport(parsed.data);
    setPending({ name: f.name, data: parsed.data, preview, history: preview.plays !== null && preview.plays > 0, settings: preview.settings.theme || preview.settings.libraryView });
  });

  const confirmImport = () => run("import", async () => {
    if (!pending) return;
    const core = await getCore();
    const r = await core.importLibrary(pending.data, { history: pending.history, settings: pending.settings, label: pending.name });
    if (pending.settings) await loadSavedTheme();
    setPending(null);
    void qc.invalidateQueries();
    const one = r.playlistsCreated === 1;
    const created = r.playlistsCreated ? ` ${plural(r.playlistsCreated, "playlist", "playlists")} added${r.queued ? `; ${one ? "it fills" : "they fill"} in as the albums arrive` : ""}.` : "";
    setStatus(r.queued
      ? { kind: "ok", text: `Importing ${plural(r.queued, "album", "albums")} from Bandcamp.${created}`, importing: true }
      : { kind: "ok", text: `Everything in ${pending.name} is in your library now.${created}` });
  });

  const doBackup = () => run("backup", async () => {
    const path = await backupLibraryDatabase();
    if (path) setStatus({ kind: "ok", text: `Backed up to ${path.split("/").pop()}.` });
  });

  const stuck = waiting ? waiting.tracks + waiting.plays + waiting.other : 0;

  return (
    <section id="library">
      <h2>Library</h2>
      <p className="muted">
        Move your library to another Mac, or keep a copy. The export lists albums by their Bandcamp address with your
        playlists, listening history, theme and settings. It never contains your identity cookie. Importing fetches the
        albums you don't have yet from Bandcamp at the usual polite pace.
      </p>
      <label className="check-row">
        <input type="checkbox" checked={withHistory} onChange={(e) => setWithHistory(e.target.checked)} />
        Include listening history in the export
      </label>
      <div className="row">
        <button className="btn" disabled={!!busy} onClick={doExport}>Export library…</button>
        <button className="btn" disabled={!!busy} onClick={chooseImport}>Import library…</button>
        {isTauri && <button className="btn" disabled={!!busy} onClick={doBackup}>{busy === "backup" ? "Backing up…" : "Back up library database…"}</button>}
      </div>
      {isTauri
        ? <p className="muted">A database backup is a complete copy of the library file, made while the app keeps running. Unlike the export, it contains your Bandcamp identity cookie if one is saved, so keep it private and don't share it.</p>
        : <p className="muted">Database backups need the app: in the browser the library lives only in memory.</p>}

      {pending && (
        <div className="library-import" role="group" aria-label={`Import ${pending.name}`}>
          <p><span className="selectable">{pending.name}</span></p>
          <ul>
            <li>
              {plural(pending.preview.albums.total, "album", "albums")}: {pending.preview.albums.new} new, {pending.preview.albums.present} already in your library
              {pending.preview.albums.invalid ? `, ${pending.preview.albums.invalid} with an address that can't be imported` : ""}.
            </li>
            <li>
              {plural(pending.preview.playlists.total, "playlist", "playlists")}: {pending.preview.playlists.new} new, {pending.preview.playlists.present} already here.
              {pending.preview.playlists.renamed.map((r) => ` "${r.from}" is added as "${r.to}" because that name is taken.`).join("")}
            </li>
            {pending.preview.account.username && (
              <li>
                {pending.preview.account.applies
                  ? `Bandcamp account ${pending.preview.account.username}${pending.preview.account.marks ? `, with Purchased and Wishlist marks on ${plural(pending.preview.account.marks, "album", "albums")}` : ""}.`
                  : `Your current Bandcamp account stays. The file's account (${pending.preview.account.username})${pending.preview.account.marks ? " and its Purchased and Wishlist marks are" : " is"} left out.`}
              </li>
            )}
          </ul>
          {pending.preview.plays !== null && pending.preview.plays > 0 ? (
            <label className="check-row">
              <input type="checkbox" checked={pending.history} onChange={(e) => setPending({ ...pending, history: e.target.checked })} />
              Merge listening history ({plural(pending.preview.plays, "play", "plays")})
            </label>
          ) : <p className="muted">The file has no listening history.</p>}
          {(pending.preview.settings.theme || pending.preview.settings.libraryView) && (
            <label className="check-row">
              <input type="checkbox" checked={pending.settings} onChange={(e) => setPending({ ...pending, settings: e.target.checked })} />
              Use the file's theme and Library settings
            </label>
          )}
          <div className="row">
            <button className="btn primary" disabled={!!busy} onClick={confirmImport}>{busy === "import" ? "Importing…" : "Import"}</button>
            <button className="btn" disabled={!!busy} onClick={() => setPending(null)}>Cancel</button>
          </div>
        </div>
      )}

      {status && (
        <div className={`notice ${status.kind}`}>
          {status.text}
          {status.importing && <> <Link to="/import">Follow it on the Import page.</Link></>}
        </div>
      )}

      {stuck > 0 && (
        <div className="row">
          <span className="muted">
            {[waiting!.tracks ? plural(waiting!.tracks, "playlist track", "playlist tracks") : null, waiting!.plays ? plural(waiting!.plays, "play", "plays") : null, waiting!.other ? plural(waiting!.other, "release setting", "release settings") : null]
              .filter(Boolean).join(", ")} from an imported library {stuck === 1 ? "is" : "are"} waiting for {stuck === 1 ? "its album" : "their albums"}.
          </span>
          <ConfirmButton label="Stop waiting" confirmLabel="Forget them" question="Forget what's still waiting?"
            onConfirm={async () => { await (await getCore()).clearPendingImports(); void qc.invalidateQueries({ queryKey: ["jobs"] }); }} />
        </div>
      )}
    </section>
  );
}
