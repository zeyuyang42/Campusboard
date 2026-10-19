# Working in this repo

Personal Bandcamp player, shipped as a Tauri 2 macOS app. Single user, no auth.
TypeScript for everything except the thin Rust shell. Read `README.md` for what
it does; this file is about how to change it safely.

## Commands

```bash
npm install                      # Node 22.5+, Rust 1.90+, Xcode CLT
npm run dev                      # tauri dev: Vite :5173 + the app window (hot reload); uses library-dev.db
npm run dev:copy-library         # snapshot the installed app's library.db into library-dev.db (read-only on the source; --force to replace)
npm run build                    # tauri build -> src-tauri/target/release/bundle/{macos,dmg}
npm test                         # vitest in packages/core, offline, uses node:sqlite + saved HTML fixtures
npm run typecheck                # core + web
VITE_BROWSER_MODE=1 npm run web:dev   # UI in a normal browser: sql.js + Vite fetch middleware, in-memory data
VITE_SELFTEST=1 npm run dev      # app runs web/src/selftest.ts and writes results to settings.key='selftest'
                                 # add VITE_SELFTEST_FAN=<public fan username> to include the collection check
npm run scrape -- <url>          # print what the parser sees (Node)
npm run fixtures:save -- <url> <name>   # refresh packages/core/test/fixtures/<name>.html
npm run smoke:live               # re-parse one known live page
```

## Layout

```
packages/core/src/
  types.ts                 DTOs shared by core and web (import "@bc/core")
  scrape/                  ALL Bandcamp parsing. url, http (FetchQueue, injected fetch), parseTralbum, parseMusic, search, fan (collection/wishlist), schemas
  db/Db.ts                 async Db interface {select,get,run}; SQL uses "?" and toDollar() rewrites to $n for the Tauri plugin
  db/repos/                one module per table; booleans stored 0/1, converted at the repo boundary
  services/                importService (upsertTralbum, vacuumOrphans), streamService, jobRunner (incl. collection sync), pageCache, account (username + identity cookie), releaseWatch (new releases checker), nowPlaying (Media Session mapping), miniPlayer (mini window state/command protocol, throttle), transition (gapless/crossfade scheduling, fade curve, state machine), libraryTransfer (library export/import file, VACUUM INTO backup)
  theme/                   schema (zod), presets, color math (OKLCH, contrast), apply (CSS variables)
  palette/                 quantize + pick + extract (canvas) + fitPalette + artUrl
  core.ts                  createCore({db, fetch, onJobsChange}) -> every function the UI calls
packages/core/test/        vitest; helpers/nodeDb.ts runs src-tauri/migrations/*.sql on node:sqlite
web/src/
  api/core.ts              getCore() singleton; Tauri plugins, or browserDb.ts when VITE_BROWSER_MODE=1
  api/queries.ts           TanStack Query hooks and mutations (names are stable; pages depend on them)
  player/store.ts          zustand store owning the two <audio> elements (audio.ts); load() asks core for a fresh stream URL; gapless/crossfade handover
  player/mediaSession.ts   Now Playing widget + media keys: navigator.mediaSession fed from the store, handlers call store actions
  player/miniBridge.ts     main-window side of the mini player: broadcasts MiniState, maps validated MiniCommands to store actions
  mini/                    the mini player window (mini.html entry): no store, no audio, no getCore; bus.ts = Tauri events or BroadcastChannel
  theme/store.ts           theme state, persisted in settings.key='theme'; usePalette.ts maps art colors to CSS vars
  ui/menu.ts + components/MenuHost.tsx   the one context menu / playlist picker for the whole app
  components/, pages/      plain CSS in styles.css driven by tokens on :root
src-tauri/
  src/lib.rs               registers sql/http/dialog/fs/opener/window-state plugins, migrations, Dock reopen
  src/backup.rs            database backup destination check + atomic copy (Rust-side save dialog)
  src/menu.rs              native menu bar; custom items run `window.__bcMenu(id)` in the main webview (web/src/lib/appMenu.ts)
  src/mini.rs              creates/toggles the `mini` window (Window > Mini Player, dock button command)
  migrations/*.sql         schema; every statement is IF NOT EXISTS so an old library.db can be adopted
  capabilities/default.json  URL scope for http (bandcamp.com, bcbits.com, custom-domain paths; LAN denied), fs scope ($APPDATA), window permissions, app commands
  capabilities/mini.json   the mini window: events, drag, hide, set-always-on-top, set-size only
  tauri.conf.json          window (Overlay title bar), CSP, bundle targets, min macOS 13.3
```

## Facts that shape the design (verified 2026-10-13)

- Bandcamp has no public API. Album/track pages embed `data-tralbum` JSON with
  `mp3-128` stream URLs; yt-dlp reads the same attribute. Treat it as the contract.
- Stream URLs expire ~24h after fetch (`ts=` query param). `core.getFreshStreamUrl`
  re-scrapes the album when a URL is within an hour of expiry; the store retries
  once with `force` on a media error. The `<audio>` element plays the CDN URL
  directly; no proxying.
- Bandcamp pages send no CORS headers, so page fetches go through Tauri's HTTP
  plugin (or the Vite middleware in browser mode). The art CDN also has no CORS,
  so palette extraction fetches bytes and decodes them, never a tainted `<img>`.
- Bandcamp's bot check ("Client Challenge" page title) is triggered by requests
  whose headers look inconsistent (e.g. Chrome `sec-ch-ua` with a Safari UA).
  Keep requests plain: UA + Accept + Accept-Language. When the challenge does
  come back, `FetchQueue` trips a `ChallengeGate` (persisted in
  `settings.key='challenge_until'`): 60 s cooldown, doubled for each challenge
  soon after, capped at 30 min. Interactive fetches fail fast with
  `challenge_cooldown` meanwhile; the job runner holds items queued and retries
  a challenged item once. If that retry is challenged too, the job stops and its
  remaining items fail with the challenge reason (no probing through a block).
  A persisted cooldown longer than the cap is dropped on load. Only a page
  titled exactly "Client Challenge" counts. No headless-browser fallback: it
  doesn't fit the app.
- Pre-orders (verified 2026-10-19 on four current pre-orders; fixture `preorder.html`):
  `data-tralbum` has `is_preorder: true` and `album_is_preorder: true`, and
  `album_release_date` (= `current.release_date`) is the future release day as
  `"30 Oct 2026 00:00:00 GMT"`. A track that isn't out yet has `file: null` and
  `unreleased_track: true`, while `streaming` may be 1 or null, so stream
  availability comes from `file`, not `streaming`. Tracks released early have a
  normal `file` with `mp3-128`. No per-track release date exists: an unreleased
  track becomes available on the album's date. Every track also carries
  `album_preorder`. `hasAudio` is false when no track is out yet. A pre-order is
  fetched once more 12 h after its release date (`services/preorder.ts`).
- Search `item_url_path` may be absolute or relative; album `img` from search
  lacks the `a` prefix real art URLs need (derive from `art_id`).
- `albums.release_date` is stored as Bandcamp sends it (`01 Oct 2021 00:00:00 GMT`),
  which does not sort as text; order by `RELEASE_KEY` in `repos/albums.ts` (2026-10-18).
- Custom artist domains (verified 2026-10-17 on music.sufjan.com and
  music.zoekeating.com): `https://<custom>/album/x` answers 303 to
  `https://<name>.bandcamp.com/album/x`, but that page's `data-tralbum.url` (and
  ld+json `@id`) is the custom-domain URL, while album `og:url` is the subdomain.
  Artist `/music` pages carry `data-tralbum="{"url":"https://<custom>/music"}"`
  and relative release links. The library stores the `data-tralbum` URL, so a
  custom-domain artist's albums live under the custom host whichever URL was
  pasted, and search's `item_url_root` is that same custom host. Hosts that
  aren't bandcamp.com are accepted only for Bandcamp-shaped paths and only
  trusted once the page has `data-tralbum`/`data-band` (`not_bandcamp` otherwise).
  The http scope therefore allows `https://*/album/*`, `/track/*` and `/music`
  on any host, with `plugins.http.scopeRedirects: true` in tauri.conf.json so
  every redirect hop is checked too (the 303 lands on `*.bandcamp.com`, which is
  in scope). Release links from `/music` pages go through `normalizeBandcampUrl`
  before they are queued, and the browser-mode proxy uses the same
  `isFetchableBandcampUrl` check on every hop.
- The http permission's `deny` list mirrors `isPublicCustomHost` so a redirect
  hop can't reach the LAN: any IPv4 literal, any IPv6 literal, bare names, and
  the private suffixes (`.local`, `.lan`, `.internal`, `.home.arpa`, ...), each
  with and without a trailing dot. In tauri-plugin-http 2.8.2 deny always beats
  allow. Pattern gotcha (urlpattern 0.6, verified 2026-10-17): fixed hostname
  text is canonicalised as a hostname, so `192.168.*` becomes `192.0.0.168*` and
  never matches; IP patterns must be regex groups like `(\d+\.\d+\.\d+\.\d+)`
  (the url crate already turns `0x7f000001`, `127.1` etc. into dotted decimal).
  Test new scope entries with the plugin's own `parse_url_pattern` before
  relying on them; the selftest's `denyScope` row checks a few in the app.
- The Tauri SQL plugin pools connections and has no transaction API. Writes are
  single statements or ordered so any interruption leaves a readable library
  (parents first, deletes last, every step idempotent). Multi-row inserts use
  `valuesList()`; playlist append computes positions inside one INSERT. A job is
  inserted as `pending` (ignored by the runner and the job list) and flipped to
  `queued` once its items exist; `resetStaleJobs` settles any left pending by a crash.
- WKWebView supports `@property`, `color-mix`, `oklch`, `OffscreenCanvas` from
  macOS 13.3, hence the minimum version.
- `core:window:default` does not include `allow-start-dragging`, so the
  `data-tauri-drag-region` band only works because the capability file grants
  it explicitly, along with hide/show/minimize/toggle-maximize/set-focus.
- App commands are listed in `build.rs` (AppManifest), so each needs an
  `allow-<command>` entry in a capability; a new `#[tauri::command]` is unreachable
  until it is added there and granted (normally to `default.json`, the main window).
- The mini player window has no audio and no core (verified 2026-10-18, selftest
  `miniPlayer`): it drives the main window's store over `mini:state` /
  `mini:command` events, which keep working with the main window hidden. The
  main window sends state only between the mini window's `hello` and `bye`.
- Event permissions have no scope: a window with `core:event:allow-emit-to` can
  send any event name to any window, and a listener with the default (Any)
  target receives events emitted to every window. So anything the main window
  listens for can be sent, and anything emitted can be read, by the mini window.
  Validate every event payload, and don't carry anything that must stay private
  to the main window in events. Menu actions therefore go from Rust to the main
  page with `webview.eval` (`window.__bcMenu`), not as a `menu` event. A forged
  `tauri://close-requested` from the mini window would only do what ⌘W does
  (save the play state and hide the main window), which is harmless.
- ⌘W is a custom Close Window item (`menu.rs` `close_window`), not the predefined
  one: AppKit's `performClose:` refuses the borderless mini window. It hides the
  mini window when that is focused, and sends the main window the usual close
  request when the main window is focused. With a native panel focused (About), it
  does nothing, because tao gives no handle to send that panel `performClose:`.
  Whenever Rust shows the mini window, it also sends the main window a `hello`, so
  the state stream never waits on WebKit's `visibilitychange`.
- Window behaviour follows Music.app: closing hides the window and playback
  continues (`persist.ts` prevents the close and calls `hide()`), the Dock icon
  reopens it (`RunEvent::Reopen` in lib.rs), Cmd+Q quits. Menu accelerators use
  Cmd so they never fight text fields; plain-key shortcuts stay in `shortcuts.ts`.
- Hidden window (verified 2026-10-18, selftest `hiddenPlayback`): with the window
  hidden for 20 s while playing, `document.visibilityState` is `hidden` but
  `timeupdate` keeps arriving at the normal rate (80 reports, max gap 254 ms), and
  listened time kept pace with the playhead (20.06 s for 20 s). Longer App Nap
  periods weren't measured, so `PlayCounter` doesn't rely on frequent reports: a
  playhead step counts if it fits the wall-clock time since the last report at
  the current `playbackRate` (+1.5 s slack); anything larger is treated as a seek.
- Gapless and crossfade (#35, measured 2026-10-19) use two `<audio>` elements
  (`audio.ts`): the active one, and a standby that preloads the next track 30 s
  before the transition point at volume 0. The rules are pure in core's
  `services/transition.ts`; only the active element's events reach the store
  (`routeElementEvent`). WebKit starts a second, preloaded AVPlayer slowly: in
  Playwright's WebKit the new element's clock began ~130-300 ms after play(),
  ~35-90 ms if it had been played (muted) and paused once first ("priming"), and
  tearing the old element down in the same instant added ~100 ms, so the store
  primes the standby muted and releases the old element 1 s later. A start lead
  didn't help in WebKit (the clock still began ~120 ms after the old one ended);
  in Chromium a 40 ms lead closed the gap to ~4 ms. In the app (muted selftest)
  the new clock started ~350-440 ms after play(). `navigator.mediaSession` is per
  document, so metadata and handlers follow the store's index whichever element
  WebKit picks; the store moves the index when the next element starts. LAME
  MP3s carry ~1105 samples of encoder delay plus end padding: Chromium trims them
  (a 12 s file reports 12.000 s), WebKit doesn't (12.042 s), so ~40 ms of silence
  stays between tracks in WebKit even with a perfect handover. The outgoing track's
  crossfade tail is not counted toward listening history: the PlayCounter moves to
  the new track when the fade starts. After priming the standby stays muted until
  it takes over, so a paused standby is never Now Playing eligible.
- Now Playing and media keys (researched 2026-10-18) come from WebKit's Media
  Session, with no native code. `MediaSessionEnabled` defaults to true for
  WKWebView since WebKit 612 (Safari 15) and is still on; no private preference
  needed. WebKit's `MediaSessionManagerCocoa` publishes the now-playing element
  through MediaRemote (the service behind MPNowPlayingInfoCenter) with the app as
  parent application, and routes the system's remote commands (F7-F9, Control
  Center, AirPods) to `setActionHandler` handlers. Eligibility
  (`MediaElementSession::canShowControlsManager`): the element must not be muted,
  must have a source, metadata and more than 0.95 s of duration, and must have
  played. A detached `new Audio()` is fine: `inActiveDocument` starts true and only
  goes false when the element is removed from a document or the page is suspended.
  Page visibility only matters for video, so a hidden window still works.
  The menu-bar Now Playing item is hidden while the window is visible and
  focused (`allowsNowPlayingControlsVisibility = !page->isVisibleAndActive()`);
  Control Center and the keys work either way.
  WebKit before mid-2024 (macOS 13/14) loads only `artwork[0]` (newer ones score `sizes`, aiming at
  512 px), so `nowPlayingMetadata` lists the 700 px art first. The app's own
  MPNowPlayingInfoCenter is not what WebKit writes, so it can't be read back to
  verify, and a native bridge would compete with WebKit's session. The selftest
  plays muted (`audio.ts`) so it never takes over the user's media keys; the
  system side (F8, the widget, AirPods) is a manual check. Volume 0 is no
  substitute: such an element is still Now Playing eligible. Muted media didn't
  advance while the window was hidden (selftest 2026-10-18: 0 s of media in 20 s,
  one timeupdate; the cause, WebKit suspending muted media in a hidden page, is
  inferred, not traced in source), so `hiddenPlayback` reports `skipped (muted)`
  unless `VITE_SELFTEST_AUDIBLE=1`.
- Library database per build (verified 2026-10-18): release builds open
  `library.db`, debug builds (`npm run dev`, the selftest) open `library-dev.db` in
  the same app data dir. `db_url()` in lib.rs chooses with `cfg!(debug_assertions)`,
  preloads it (the `sql` preload is set in code, not tauri.conf.json) and the web
  side asks for the name with the `library_db_url` command. Before this split, dev
  runs applied branch migrations to the real library. For debug builds only,
  `BCP_DB_PATH=<absolute path>` opens a scratch file and `BC_NO_DIALOG=1` skips the
  startup alert (exit code 2 = newer library, 3 = edited migration, 1 = other).
- tauri-plugin-sql 2.5 runs sqlx's migrator with `ignore_missing = false`. A build
  that lacks a migration recorded in `_sqlx_migrations` fails with `VersionMissing`;
  editing an applied migration file, even a comment, changes its checksum and fails
  with `VersionMismatch`. Either way plugin setup fails, so `build()` errors and the
  app shows a native alert (rfd) pointing to the latest release, then exits. Recovery
  for a library migrated by a newer build when you must run the older one: quit the
  app and `DELETE FROM _sqlx_migrations WHERE version > N` (N = the older build's
  last migration). That is safe because every migration is IF NOT EXISTS, so the
  newer build re-records them later; the newer tables stay and are ignored.
- Listening history (`plays`): a play counts once per playback after
  min(50%, 4 min) of listened time, for tracks over 30 s (`services/playRule.ts`).
  `played_at` is when the play counted, not when the track started, and
  `seconds_listened` is the listened time at that moment (the threshold plus at
  most one report's step), not the whole listen. `ix_plays_played_at` is unused
  so far; it stays because 0005 is applied to existing libraries.
- New releases (`services/releaseWatch.ts`, tables `release_watch` and
  `artist_releases`): one tick every 3 min starting 3 min after launch, at most
  one artist and one request per tick (page cache, no retries), each artist at
  most once per 24 h; skipped while a job is queued/running, during a challenge
  cooldown or with `settings.key='release_check'` = `{enabled:false}`. An
  artist's first successful check is a baseline (all `seen`). Release URLs go
  through `normalizeBandcampUrl` before they are stored. The selftest's
  `newReleases` block covers it through the real plugins.
- Library export/import (`services/libraryTransfer.ts`, format
  `bandcamp-player-library` version 1, zod-validated): everything is keyed by
  Bandcamp identity (album URL, track id, band id), never local row ids, and the
  file never carries the identity cookie, sync summary, page cache, stream URLs
  or palettes. Import queues missing albums as a `library` job and writes
  playlist entries, plays, mutes and dismissals as `import_pending` rows
  (0007) that the job runner resolves after every item; `imported_playlists`
  makes re-imports idempotent. Saving goes through the dialog plugin, which adds
  exactly the chosen file to the fs scope at runtime, so the capability file
  stays $APPDATA-only. Every URL from a file goes through `normalizeBandcampUrl`
  before it is queued or stored; Purchased/Wishlist `fetch_url`s must be on
  bandcamp.com and name the same release path. Backups `VACUUM INTO` a fresh
  `backup-<ms>.tmp.db` in $APPDATA; the Rust `backup_library` command
  (`src/backup.rs`) shows the save dialog itself, refuses the data/config folders
  and the live database by (device, inode) after canonicalizing, and copies
  through a temp file + rename. Stale snapshots are swept at startup. A backup
  contains the identity cookie; the export never does.

## Collection sync facts (verified 2026-10-17 with curl against a public profile)

- A public fan page `https://bandcamp.com/<username>` embeds `#pagedata[data-blob]`
  JSON: `fan_data.fan_id`, `collection_data`/`wishlist_data` (`item_count`,
  `last_token`, first 20 keys in `sequence`, or `pending_sequence` for the tab that
  isn't open) and the items in `item_cache.collection|wishlist`. A missing user is a 404.
- `POST https://bandcamp.com/api/fancollection/1/collection_items` and `/wishlist_items`
  with `{fan_id, older_than_token, count}` work without any cookie for public profiles.
  `count` up to at least 100 is honoured. With `count` > 20 the response's `last_token`
  is the 20th item's token, not the last one's, so page on from the last item's own
  `token` (verified: no overlap). An unknown fan id returns `items: []`.
- Items carry `tralbum_type` (`a`/`t`), `tralbum_id`, `item_url` (the custom domain
  when the artist has one) and `url_hints.subdomain`. On track items `url_hints.slug`
  can name the album, so never build URLs from the slug. A custom-domain release is
  also served at `https://<subdomain>.bandcamp.com/<same path>` with a 200 (no
  redirect) and `data-tralbum.url` still names the custom domain.
- Anonymous fan pages have `identities.fan: null` and `fan_data.is_own_page: null`.
  A made-up `identity` cookie is ignored (page stays anonymous, 200). What a valid
  cookie adds is NOT verified here (no account available): per bandcamp-fetch it is
  private collections and `mp3-v0` in `data-tralbum` file maps for owned items, and the
  sync treats a page with `identities.fan` set and `is_own_page` true as "accepted".
- tauri-plugin-http 2.8.2 drops `Cookie` (a fetch-spec forbidden header) unless the
  crate is built with `unsafe-headers`; its default `cookies` feature keeps a jar in
  `<app cache>/.cookies` that stores every `Set-Cookie` and replays it. The app builds
  with `unsafe-headers` and without `cookies`, so the identity cookie goes only where
  core puts it (reqwest also strips an explicit `Cookie` on a cross-host redirect).

## Rules

- Be polite to Bandcamp: keep `FetchQueue` serial at 1 req/s with the browser UA
  and the 10-minute page cache. Palette art fetches bypass the queue on purpose
  (static CDN, one small image per track change).
- Keep parsing inside `packages/core/src/scrape/`. When markup changes: fix the
  parser, re-save fixtures, `npm test`.
- Schema changes are a new numbered file in `src-tauri/migrations/` plus an entry
  in `src/lib.rs` (and an import in `web/src/api/browserDb.ts`); never edit an applied
  migration, not even a comment (`VersionMismatch`, see above). `albums.owned` mirrors the synced collection (`fan_items`), recomputed in
  one statement; `tracks.stream_quality` is `mp3-v0` or `mp3-128`; `tracks.local_path`
  is reserved for a planned feature.
- The identity cookie lives only in `settings.key='bandcamp_identity'`. Read it only
  through `services/account.ts` (`identityHeaders`), which sends it only to https
  bandcamp.com and `*.bandcamp.com`, never to a custom domain. Never log it, put it in
  an error message, a job row, the page cache or the self-test output.
  `core.getSetting`/`setSetting` refuse the account, cookie and sync-status keys. A
  cookie a sync found rejected still goes to the fan page (so it can recover) but not
  to album pages. Once any sync was signed in, only a signed-in sync removes items
  from the lists, and removing or changing the account cancels the sync job first
  (its list writes are conditional on the job still running).
- Albums the user removes are recorded in `fan_dismissed` and not re-imported by a
  sync; importing the release by hand clears that.
- Theme files are data: `applyTheme` only ever calls `style.setProperty`. Never
  interpolate theme values into CSS text. New theme fields go through
  `ThemeSchema` with bounds, and bump `version` only for breaking changes.
- No `window.prompt`/`confirm`/`alert`: WKWebView handles them badly. Use inline
  inputs and `ConfirmButton`.
- Navigate from non-React code with `navigateTo()` in `web/src/lib/navigation.ts`;
  never `window.location.assign` (a reload drops the player state).
- Chrome text is unselectable with the arrow cursor inside Tauri; add the
  `selectable` class to any new element whose text people should copy.
- The player store is the only code that touches the audio elements (`audioEls`). UI calls store actions.
- Keep it personal-use: always render the "Buy on Bandcamp" link on album pages.
- The `sqlite3` CLI has foreign keys OFF by default; prefer the app's own
  functions over manual deletes in `library.db` / `library-dev.db`.

## Verifying changes

1. `npm test` and `npm run typecheck`.
2. UI: run `VITE_BROWSER_MODE=1 npm run web:dev` and drive it with Playwright
   (installed outside the repo). Launch Chromium with
   `--autoplay-policy=no-user-gesture-required`; `window.__bcAudio` exposes the
   audio element. Full-page navigation resets the in-memory database, so navigate
   through the sidebar links. Vite proxies Bandcamp at `/bc-proxy/<encoded url>`.
3. Runtime: `VITE_SELFTEST=1 npm run dev`, then read
   `SELECT value FROM settings WHERE key='selftest'` from
   `~/Library/Application Support/com.bandcampplayer.app/library-dev.db` (debug
   builds never open `library.db`). It starts empty; `npm run dev:copy-library`
   seeds it from the real library when a test needs real data. Extend `web/src/selftest.ts` when adding features that touch Tauri plugins.
   The selftest plays muted, so `hiddenPlayback` is skipped. Changes to the player,
   background playback or listening history need one
   `VITE_SELFTEST=1 VITE_SELFTEST_AUDIBLE=1 npm run dev` run as well: it is audible
   and takes over Now Playing and the media keys while it runs, so warn the user first.
4. Screenshots of the real window need Screen Recording permission for the
   terminal (`screencapture -l <windowid>`); without it, use browser mode.
5. Release: `npm run build`; open the `.app` from `src-tauri/target/release/bundle/macos/`.

## Backlog

Planned features are GitHub issues labelled `feature`
(https://github.com/zeyuyang42/bandcamp-player/issues). Check there before
proposing new scope.
