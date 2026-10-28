# Working in this repo

Campusboard: a personal Bandcamp player, shipped as a Tauri 2 macOS app. Single user,
no auth. It was called Bandcamp Player until 0.6.2 (renamed 2026-10-20, released as 0.7.0); the bundle
identifier `com.bandcampplayer.app`, the crate/package names and the export format id
`bandcamp-player-library` keep the old name on purpose: changing the identifier would
move the library, downloads, WebKit storage and notification permission to a new,
empty app data folder, and changing the format id would break old exports.
TypeScript for everything except the thin Rust shell. Read `README.md` for what
it does; this file is about how to change it safely.

## Commands

```bash
npm install                      # Node 22.5+, Rust 1.90+, Xcode CLT
npm run dev                      # tauri dev: Vite :5173 + the app window (hot reload); uses library-dev.db
npm run dev:copy-library         # snapshot the installed app's library.db into library-dev.db (read-only on the source; --force to replace)
npm run build                    # tauri build -> src-tauri/target/release/bundle/{macos,dmg}
npm test                         # vitest: packages/core (node:sqlite + saved HTML fixtures), then web (happy-dom); offline
npm run test -w web              # just the web suite (player store, persistence, mini bridge; ~1 s)
npm run typecheck                # core + web
VITE_BROWSER_MODE=1 npm run web:dev   # UI in a normal browser: sql.js + Vite fetch middleware, in-memory data
VITE_SELFTEST=1 npm run dev      # app runs web/src/selftest.ts and writes results to settings.key='selftest'
                                 # add VITE_SELFTEST_FAN=<public fan username> to include the collection check
npm run scrape -- <url>          # print what the parser sees (Node)
npm run fixtures:save -- <url> <name>   # refresh packages/core/test/fixtures/<name>.html (scrubbed: no supporters, fan comments or visitor country)
npm run smoke:live               # re-parse one known live page
```

## Layout

```
packages/core/src/
  types.ts                 DTOs shared by core and web (import "@bc/core")
  scrape/                  ALL Bandcamp parsing. url, http (FetchQueue, injected fetch), parseTralbum, parseMusic, search, fan (collection/wishlist), radio (Bandcamp Radio list + episode), discover (results, tag/place search, discover links), discoverGenres (genre/subgenre chips), schemas (zod, with the lenient str/num/items helpers), challenge (bot-check gate), errors (ScrapeError codes, describeError), html (entity decoding, clean, assertNotChallenge); url.ts has releaseUrlOrNull (every URL from markup, Bandcamp JSON or a library file goes through it before it is queued, stored or shown) and hostOf; http.ts has postJson for the JSON APIs
  db/Db.ts                 async Db interface {select,get,run}; SQL uses "?" and toDollar() rewrites to $n for the Tauri plugin; placeholders()/chunks() for IN lists and chunked writes; sqlTime()/now()/sqlTimeIso() for the library's UTC "YYYY-MM-DD HH:MM:SS" timestamps
  db/repos/                one module per table; booleans stored 0/1, converted at the repo boundary; crates (crates + crate_albums, #126) and albumArchive (album_archive, the ARCHIVED/NOT_ARCHIVED SQL and ArchiveScope) are the user's own grouping and parking of albums
  services/                importService (upsertTralbum, vacuumOrphans; the upsert only vacuums when tracks moved or the album changed artist), time (clock: m:ss / h:mm:ss), streamService, jobRunner (incl. collection sync), pageCache, account (username + identity cookie), releaseWatch (new releases checker), nowPlaying (Media Session mapping), miniPlayer (mini window state/command protocol, throttle), transition (gapless/crossfade scheduling, fade curve, state machine), libraryTransfer (library export/import file, VACUUM INTO backup), radio (episodes, tracklists, stream URLs), discover (preview queue entries + their stream URLs), offline (offline copies: download, local URL, sweep), resume (resume points for long tracks), sleepTimer, playRule (when a play counts), preorder, collectionRefresh (daily sync), idle (when background work may run), audioEvents (routing the two elements' events), playerToggle, volume
  theme/                   schema (zod), presets, color math (OKLCH, contrast), apply (CSS variables)
  palette/                 quantize + pick + extract (canvas) + fitPalette + artUrl; boost (palette v2: raw swatches -> vivid backdrop colours)
  config.ts                settings keys and their parsers
  core.ts                  createCore({db, fetch, onJobsChange}) -> every function the UI calls
packages/core/test/        vitest; helpers/nodeDb.ts runs src-tauri/migrations/*.sql on node:sqlite
web/test/                  vitest + happy-dom for the player wiring; FakeAudio stands in for new Audio(), harness.ts boots a fresh store with a stub getCore()
web/src/
  api/core.ts              getCore() singleton; tauriDb.ts + offlineFiles.ts over the Tauri plugins, or browserDb.ts when VITE_BROWSER_MODE=1
  api/queries.ts           TanStack Query hooks and mutations (names are stable; pages depend on them); useAddRelease(url, onDone?) is the one card-level import tracker (Search, Discover, New releases, Radio, Browse), isJobActive the one job-status predicate
  api/invalidate.ts        KEY_GROUPS (named query-key prefix groups: library, libraryTracks, history, offline, jobs), invalidateGroup(name) for code outside React, bindQueryClient
  player/init.ts           boots the store, persistence, media session and mini bridge once; radio.ts = radio episode playback helpers
  player/store.ts          zustand store owning the two <audio> elements (audio.ts); load() asks core for a fresh stream URL; gapless/crossfade handover
  player/mediaSession.ts   Now Playing widget + media keys: navigator.mediaSession fed from the store, handlers call store actions
  player/miniBridge.ts     main-window side of the mini player: broadcasts MiniState, maps validated MiniCommands to store actions
  mini/                    the mini player window (mini.html entry): no store, no audio, no getCore; bus.ts = Tauri events or BroadcastChannel
  theme/tokens.css         the :root fallback tokens, @property registrations and token transition both windows share; imported before styles.css and mini.css, which add only their own tokens
  theme/store.ts           theme state, persisted in settings.key='theme'; usePalette.ts maps art colors to CSS vars
  backdrop/                the album-art backdrop (#110): Backdrop.tsx (replaces Ambient), controller (pure rules), engine (loop, GL injected), gl (raw WebGL1), shaders (GLSL strings), swatches (boosted palette store)
  components/Seek.tsx      the presentational scrub bar; SeekBar binds it to the store, the mini window to its seek command
  lib/                     small shared helpers: useDebounced, openExternal, format (plural, formatDateTime, durations), navigation, removals
  ui/menu.ts + components/MenuHost.tsx   the one context menu / playlist picker / crate picker for the whole app (reopenMenuAs for a submenu)
  ui/palette.ts + lib/paletteActions.ts   the ⌘K command palette (ui/store.ts holds its open state)
  ui/undo.ts + components/UndoNote.tsx   the one "Removed X. Undo" note; lib/removals.ts starts removals with it
  components/, pages/      plain CSS in styles.css driven by tokens on :root
src-tauri/
  src/lib.rs               registers sql/http/dialog/fs/opener/notification plugins, migrations (one migration!(version, description, file) line each), Dock reopen; MAIN_LABEL, main_window() and reveal() (unminimize, show, focus) for the main window
  src/geometry.rs          window size + position in points (window-geometry.json; -dev in debug builds)
  src/backup.rs            database backup destination check + atomic copy (Rust-side save dialog)
  src/menu.rs              native menu bar; custom items run `window.__bcMenu(id)` in the main webview (web/src/lib/appMenu.ts)
  src/fullscreen.rs        hide_main_window: leave native full screen, then hide on NSWindowDidExitFullScreenNotification (2 s fallback)
  src/mini.rs              creates/toggles the `mini` window (Window > Mini Player, dock button command); tell_main(app, "hello" | "bye") is the only Rust emitter of mini:command
  src/tray.rs              optional menu-bar icon (Settings, off by default); `set_menu_bar` from web/src/lib/menuBar.ts; items reuse menu.rs ids
  migrations/*.sql         schema; every statement is IF NOT EXISTS so an old library.db can be adopted
  capabilities/default.json  URL scope for http (bandcamp.com, bcbits.com, custom-domain paths; LAN denied), fs per command (mkdir/copy-file/read-file in $APPDATA/backgrounds only; no static scope otherwise), window permissions, app commands
  capabilities/mini.json   the mini window: events, drag, hide, set-always-on-top, set-size, and the read-only notification:allow-is-permission-granted (see Facts)
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
  it explicitly, along with hide/show/minimize/toggle-maximize/set-focus. The main
  window has no `core:window:allow-close` either: nothing in web/ calls the Tauri
  `close()`; ⌘W closes from Rust and persist.ts prevents the close request and hides
  (2026-10-21).
- App commands are listed in `build.rs` (AppManifest), so each needs an
  `allow-<command>` entry in a capability; a new `#[tauri::command]` is unreachable
  until it is added there and granted (normally to `default.json`, the main window).
- tauri-plugin-notification 2.7 on macOS posts through notify-rust /
  mac-notification-sys (NSUserNotification). Its desktop `request_permission`
  resolves "granted" without prompting (checked in the crate source,
  2026-10-19); the user controls it in System Settings → Notifications. Under
  `tauri dev` notifications are attributed to Terminal; only the built app
  posts under its own name. The plugin injects a `window.Notification` shim into
  every webview (its `js_init_script` has no window scope or config option), and
  the shim calls `is_permission_granted` on each page load. So mini.json grants
  only that read-only command, or every mini window load logs an ACL rejection.
  Nothing in the mini window can post a notification.
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
  reopens it (`RunEvent::Reopen` in lib.rs), Cmd+Q quits. Hiding a window in native
  full screen leaves its Space behind, black and empty (2026-10-21), so persist.ts hides
  through the `hide_main_window` command (`src/fullscreen.rs`): a windowed main window is
  hidden at once; a full-screen one gets a one-shot `NSWindowDidExitFullScreenNotification`
  observer on its NSWindow (objc2 `define_class!`), then `set_fullscreen(false)`, and the
  observer removes itself and hides on a later event-loop turn (queued from another
  thread: `run_on_main_thread` called on the main thread runs inline, and sync commands
  are on the main thread). A 2 s fallback hides anyway if the notification never comes;
  a `reveal()` during the wait (Dock reopen, the mini player's Show through the
  `show_main_window` command) cancels the late hide, and a second close during it only
  re-arms it (`HideState`, unit-tested). The window
  reopens windowed. The end can't be read from tao 0.37: `set_fullscreen(None)` clears
  its `fullscreen` state synchronously (window.rs:1261), so `isFullscreen()` is false
  for the whole animation, and a close during the enter transition is queued by tao
  (`target_fullscreen`) and only starts after `windowDidEnterFullScreen:`. For the same
  reason `geometry.rs` skips a frame covering the whole screen. Written from the tao and
  AppKit docs; not yet tried in a real full-screen Space. Menu accelerators use
  Cmd so they never fight text fields; plain-key shortcuts stay in `shortcuts.ts`.
- Drag and drop (#92, checked 2026-10-20 in wry 0.57 / tauri-runtime-wry 2.12 source,
  selftest `dropLink`): with `dragDropEnabled` on (Tauri's default) the WKWebView
  subclass answers every NSDraggingDestination call itself and never calls super, so
  WebKit sees no drag at all: no HTML5 `drop`, not even for in-page drags (the queue
  reorder), and a dragged URL arrives as `tauri://drag-drop` with an empty `paths`
  list (it only reads `NSFilenamesPboardType`). The main window sets
  `dragDropEnabled: false`: wry then calls super for everything, so a link from Safari
  or Chrome arrives as `text/uri-list` + `text/plain`, a Finder file as `Files`. One
  wry quirk stays: `draggingUpdated` turns WebKit's "none" into Copy, so the cursor
  shows a copy badge even where the page sets `dropEffect = "none"` (over files); the
  drop then reaches the page, which ignores it. `lib/dropLink.ts` reads only text and
  never files. It has no drag state: in-page drags carry `application/x-bc-internal`
  (set in a capture `dragstart`) and are left to their targets, any other drag with `Files`
  is always cancelled, plain text over a text field is left to WebKit, and every
  other outside drag is cancelled so WebKit never opens it in the webview. The
  backstop is `navigation_guard` in lib.rs: the main window may only load the app's
  own origin (`tauri://localhost`, the dev server in debug builds). External links
  use the opener plugin, which is not a navigation. The mini window keeps the native
  handler, which swallows drops there. A dropped custom-domain homepage is not
  treated as a label (any site's `/` normalizes to `/music`): it needs `/music` or
  `/releases` in the link, or a host already in the library.
- Appearance (#43, selftest `appearance`): `Window.setTheme` sets the NSWindow
  appearance, which is also what WKWebView's `prefers-color-scheme` reports, so a
  pinned dark/light theme pins the query too and a system theme must call
  `setTheme(null)` before it can follow macOS again (`setNativeAppearance` in
  theme/store.ts). Needs `core:window:allow-set-theme` (main window only; the
  undecorated mini window gets the theme already resolved from the main window).
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
- AirPlay (#42, researched in WebKit source 2026-10-20, at the macOS 13.3 tag
  `WebKit-7615.1.26.11.1` and `main`; not yet tried against a real speaker) uses
  WebKit's own picker, no native code. `ENABLE_WIRELESS_PLAYBACK_TARGET` is on for
  every Cocoa platform; `webkitShowPlaybackTargetPicker()`,
  `webkitCurrentPlaybackTargetIsWireless` and the
  `webkitplaybacktargetavailabilitychanged` event are exposed to page content
  (unconditionally at the tag; behind `WirelessPlaybackTargetAPIEnabled`, default
  true except visionOS, on main). `WKWebViewConfiguration.allowsAirPlayForMediaPlayback`
  is macOS 10.11+ and defaults to YES; wry 0.57 never changes it, so nothing is set
  from Rust. The picker needs a user gesture (the button click) and, on macOS,
  `readyState >= HAVE_METADATA`. A detached `new Audio()` registers with the
  document in its constructor, so it gets availability events and the picker; the
  hidden-element check on route monitoring is iOS-only. WebKit routes one element
  per page to the target, the one that opened the picker
  (`WebMediaSessionManager::configurePlaybackTargetClients`), and the element keeps
  the route across new sources (`MediaElementSession::mediaEngineUpdated`). So while
  `airplayActive` the store skips gapless and crossfade and loads the next track
  into the same element; the saved settings are untouched. The page hears nothing
  when the picker is dismissed, so after a picker call the same hold lasts until a
  wireless-changed event or the next track loads (that transition is plain). If the
  user presses Next with the picker still open and picks after a later gapless
  handover, the route lands on the outgoing element (rare; the next handover back
  fixes it). While routed, a media error on an offline (`asset:`) copy streams once
  but never marks the copy suspect: AVFoundation playing a custom-scheme source to
  a speaker is untested, so the route, not the file, may be at fault. Control Center's Sound menu routes the whole app instead, with gapless
  intact. The selftest's `airplay` block reports whether the API exists and never
  opens the picker (2026-10-20, macOS 15.7: picker, wireless property, the
  availability event and `remote` all present on the detached elements).
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
  exactly the chosen file to the fs scope at runtime (see the fs scope fact). Every URL from a file goes through `normalizeBandcampUrl`
  before it is queued or stored; Purchased/Wishlist `fetch_url`s must be on
  bandcamp.com and name the same release path. Backups `VACUUM INTO` a fresh
  `backup-<ms>.tmp.db` in $APPDATA; the Rust `backup_library` command
  (`src/backup.rs`) shows the save dialog itself, refuses the data/config folders
  and the live database by (device, inode) after canonicalizing, and copies
  through a temp file + rename. Stale snapshots are swept at startup. A backup
  contains the identity cookie; the export never does.
- The webview's fs scope (#78, verified 2026-10-20 in the muted selftest
  `fsScope`): no `fs:default` and no `fs:scope-*` set, both of which reach all of
  $APPDATA (default: every read command; scope-appdata-recursive: every command,
  so writes, removes and renames of `library.db`). The capability grants
  `fs:deny-default` plus the commands the web code calls; only `mkdir`
  (`$APPDATA/backgrounds`), `copy-file` and `read-file` (`$APPDATA/backgrounds/*`)
  carry a static scope, for theme background images. Everything else is reached
  through the runtime scope (`app.fs_scope()`, shared by every fs command):
  files the open/save dialogs add (theme and library import/export) and the
  `<db stem>-offline/` folder lib.rs adds at startup, which follows the live
  database for release, dev and `BCP_DB_PATH` runs. Backup snapshots need no fs
  scope: the SQL plugin writes them (`VACUUM INTO`) and Rust removes them. The
  plugin checks the symlink-resolved path, and a `..` component is refused before
  that (`cannot traverse directory`). The selftest stands in for the dialogs with
  the debug-only `selftest_file` command (a `selftest-*` file in the temp folder
  added to the scope, and its cleanup). The mini window has no fs permission.
- Bandcamp Radio (#44, verified 2026-10-19 with curl; fixtures `radio.html`,
  `radio-show.html`): `https://bandcamp.com/radio` embeds `data-blob` with
  `appData.shows` (20 latest episodes, newest first: `itemId`, `title`,
  `franchiseName`, `date`, `description`, `imageId`, `itemUrl`) and `numPages`.
  An episode page (`/radio?show=<id>` 302s to `/radio/<programme-slug>/<id>`)
  has `appData.show` with `compiledTrack.{streamUrl,duration}` (one mp3 for the
  whole episode, 60-90 min) and `tracks[]` each with `timecode` (seconds into
  that file), `title`, `artistName`, `url`, `artId` and `album.{title,url,artId}`
  (`album` is null for a standalone track). `streamUrl` is
  `https://bandcamp.com/stream_redirect?enc=mp3-128&track_id=..&ts=<issued>&t=<sig>`:
  `ts` is the issue time (not an expiry), the signature is checked (a changed
  `ts` gives 404), one 25 min old still redirected, and it 302s to a normal
  `t4.bcbits.com/stream/...mp3-128` URL whose own `ts` is +24 h. Images use
  `f4.bcbits.com/img/<10-digit imageId>_<size>.jpg` with no `a` prefix
  (`radioImageUrl`). The old `api/bcweekly/3/list` still answers (977 episodes
  back to 2013, 640 KB, programme names wrong for new shows) but
  `api/bcweekly/3/getshow` says "bad function"; use the pages. Costs: the list
  page at most once a day (page cache), an episode page once per play (page
  cache 10 min, tracklist kept in memory) plus one `stream_redirect` request.
  Core resolves that redirect itself through `FetchQueue.resolveRedirect`
  (`redirect: "manual"`, which `api/core.ts` maps to plugin-http's
  `maxRedirections: 0` = reqwest `Policy::none`, so the 302 and its Location come
  back unfollowed; the browser-mode proxy reports it as `x-bc-location`). The
  Location must match `RADIO_CDN_URL` (https, `*.bcbits.com/stream/`). The
  `<audio>` element only ever gets the CDN URL, so the CSP is unchanged, and the
  URL carries the CDN's real 24 h `ts`; it is reused in memory until an hour
  before that. An episode restored at launch is not resolved until Play. An
  episode is a queue entry with `id = album_id = -showId` and a `radio` field;
  it is not counted in listening history (`plays` keys library tracks) and
  can't be added to a playlist.
- Offline copies (#2, verified 2026-10-20 in the muted selftest `offline`): core's
  `services/offline.ts` saves a library track's current stream (mp3-128, or
  mp3-v0 for a purchase synced with the cookie) as `<Bandcamp track id>.mp3`
  through an injected `OfflineFiles`; `tracks.local_path` holds that name and
  `track_files` (0008) its size. Downloads are `download` jobs (one item per
  track, `<album url>#track=<id>`) in the normal JobRunner: the album page
  refresh and the mp3 both go through `FetchQueue` (`download()` takes a queue
  slot for the request, then streams the body; plugin-fs `writeFile` with a
  ReadableStream opens the file and writes each plugin-http chunk, so nothing is
  buffered), honour the challenge cooldown, resume after a restart and cancel
  between tracks; Remove download / Remove all also abort the track in flight
  (its AbortSignal goes through `FetchQueue.download`), and its finalising step,
  queued behind the removal on the same exclusive chain, discards the file.
  `download()` has an idle timeout (`DOWNLOAD_IDLE_MS`, no data for 60 s) that
  starts once the queue slot is ours, not a total one, and tells a failure
  reading the body (`fetch_failed`, `network`) from one writing the file
  (`disk_error`, `full` on ENOSPC). A CDN 4xx gets one forced album re-scrape per
  job; after that a refused track fails alone, and a second refused track in a
  row is `cdn_refused`, which fails the job's remaining tracks like
  `storage_full` and a full disk. Without a Content-Length, an mp3-128 under
  60% of duration × 16 kB/s counts as cut off. A file is written as `.part` and renamed when complete. The
  folder is `<db stem>-offline/` next to the database (`library-offline`,
  `library-dev-offline`, or beside a `BCP_DB_PATH`), in Application Support
  rather than Caches (macOS may purge Caches). lib.rs creates it and adds it,
  canonicalized, to the fs scope and the asset protocol scope at runtime; the
  config's `assetProtocol.scope` is empty, and the CSP's `media-src` allows
  `asset:`/`http://asset.localhost`. `<audio>` plays `convertFileSrc(path)`;
  the asset protocol answers Range requests, so seeking works and the file is
  never read into the webview. Each library sweeps its own folder (startup,
  after deleting an album, refreshing one, `vacuumOrphans`): files no track
  names go, rows whose file is gone are cleared. The player asks
  `core.localTrackUrl` first (no request at all), streams otherwise, and after a
  media error on a local file retries with the stream, and forgets the copy only
  once that stream retry plays (never offline, where a transient error such as
  sleep/wake must not cost a good copy).
  During a challenge cooldown a failed load skips on (rather than stopping) when
  another queue entry has a copy (`core.downloadedTrackIds`). A stream fetch that gets no answer
  (`fetch_failed` with `detail.network`) marks the player offline for 30 s,
  during which tracks without a copy fail at once and the #74 skip moves on to
  the downloaded ones. Radio episodes always stream. The library export never
  includes copies, names or sizes.

- Discover (#104, verified 2026-10-21 with curl; fixtures `discover.json`,
  `tag-search.json`, `geoname-search.json`): the `/discover/...` page carries only
  its filters (`#pagedata[data-blob]` `appData.initialState`: categories, slices,
  times, genres, locations, customTags). Results come from
  `POST https://bandcamp.com/api/discover/1/discover_web` with
  `{category_id, tag_norm_names, geoname_id, slice: top|new|rand, time_facet_id, cursor: "*"|<cursor>, size: 60, include_result_types: ["a","s"], followed_bands: false}`;
  no cookie needed, `"t"` in `include_result_types` gives an error. The answer is
  `{results, result_count, batch_result_count, cursor}`; each result has
  `item_url` (custom domain when the artist has one, `?from=discover_page`
  appended), `band_url`, `primary_image.image_id` (an art id: needs the `a`
  prefix), `release_date` (`"2026-09-04 00:00:00 UTC"`), `is_album_preorder` and
  `featured_track {id, title, band_name, duration, stream_url}` with a
  `t4.bcbits.com/stream/.../mp3-128/<id>?...&ts=` URL (~24 h). Times: default -1
  ("fresh", sent as `time_facet_id: null`), 0 today, 1 this week, 2-7 = 1-6 weeks
  ago; Bandcamp's links write `t=<slug>` but its parser reads `t` as a number, so
  `parseDiscoverUrl` takes both. Links: `/discover/<tag+tag|all>[/<category>]?s=&t=&loc=&tags=a,b`;
  the category slugs `digital`, `vinyl`, `cd`, `cassette` are `category_id` 1-4 (0 all; `tshirt`
  = 5 is left out: no audio), kept in the app's query as `cat=<slug>`. Genres (2026-10-21):
  `initialState.genres` (27, `{id,label,slug}`) and `.subgenres` (237, plus `parentSlug`; none
  for podcasts and audiobooks) are copied into `scrape/discoverGenres.ts`, not fetched. A slug
  is the tag norm name `tag_norm_names` takes, even where the label differs (`hip-hop/rap` ->
  `hip-hop-rap`, `drum & bass` -> `drum-bass`, `méxico d.f.` -> `méxico-d.f.`): checked with
  `["hip-hop-rap"]` (511,635 results), `["latin","méxico-d.f."]` (15: tags are ANDed) and an
  unknown tag (0). Genre and subgenres are plain tags: the first genre tag is the selected
  genre (Bandcamp's links put it first), picking another replaces it and its subgenres. Tag autocomplete:
  `POST api/bcsearch_public_api/1/tag_search {prefix}` -> `[{norm_name, display_name, count}]`;
  places: `POST api/location/1/geoname_search {q, n: 5, geocoder_fallback: false}` ->
  `{ok, results: [{id: "<string>", name, fullname}]}`. `GET api/stream/1/refresh?url=<stream_url>`
  -> `{track_id, url}` (tried on a URL not yet expired; core falls back to the release
  page's `data-tralbum` if it fails). Costs: one POST per filter change or "Show
  more" (TanStack Query: `staleTime: Infinity`, so loaded pages are never refetched on
  their own, dropped 5 min after the page leaves the screen; not under the "albums"
  key, so an import doesn't refetch them: a finished Add patches the cached pages
  with `setQueriesData`), the
  autocompletes debounced 300 ms (2+ / 3+ characters), nothing prefetched. A
  preview is a queue entry with `id = album_id = -(1e10 + track id)` and a
  `preview` field (`services/discover.ts`): never counted, never in a playlist,
  `isRadioTrack` is false for it, and a restored one resolves its URL only on Play.
  The last setup is `settings.key='discover_last'`.

- Album-art backdrop (#110, 2026-10-21). Palette v2: one decode of the 350 px art yields the
  conservative trio (`art_palettes`, five clusters, unchanged) and up to six raw k-means
  swatches (`art_swatches`, migration 0012, JSON validated with `ArtSwatchesSchema` on read;
  key = art_id, or -(image_id) for a Radio episode, which gets a palette this way). The
  raw swatches are cached; `boostSwatches` (pure, `palette/boost.ts`) raises chroma, re-spreads
  lightness by rank and turns grey art into a tinted neutral at read time, so tuning the boost
  never invalidates the cache. `core.getArtSwatches` fills both caches from one request, as
  does `getArtPalette`. Theme `backdrop` (schema version still 1, defaulted additively):
  `mode` conservative / wash / morph, `style` ink / aurora / glitch / lava (`grain` in a saved
  theme or theme file is the 0.9.0 name of glitch, mapped by `STYLE_ALIASES` in schema.ts; see
  the #113 fact below), `intensity`, `motion` drift / still; new and existing installs land on
  morph + ink. `applyTheme` writes
  `data-backdrop` on `:root` (the mini window gets it with the theme). Morph is raw WebGL1
  (one fullscreen triangle, GLSL as template strings: no three.js, no worker, no blob:, CSP
  unchanged), rendered at half the window size (DPR ignored, max 960×540) at 30 fps for every
  style (`controller.ts` `fps`), with `powerPreference: "low-power"`. The rules live in `backdrop/controller.ts`:
  anything but a playing track, a hidden document, `motion: still` or Reduce motion freezes
  the canvas on its last frame (no frames at all, and the shader clock keeps its phase); a
  track change cross-fades the two palettes for 2 s even while frozen; a lost context, or no
  WebGL, shows the CSS wash instead (`data-gl="lost"`). Never call
  `WEBGL_lose_context.loseContext()` on a canvas that may be reused: a canvas has one context
  for life and React StrictMode remounts the effect in dev. `webglAvailable()` is reported by
  the selftest's `window` block (`webgl`, plus `backdrop.state`/`frames`), and
  `window.__bcBackdrop = {state, frames, time, setTime}` is there for Playwright (`setTime`
  jumps the shader clock, debug only: it lands a screenshot on a glitch burst). Verified 2026-10-21 in
  headless Chromium (SwiftShader): playing → `gl-drift` at ~31 fps, pause → `gl-frozen` with
  frames stopped, a palette change while paused → `gl-fading` for 2 s then frozen, Reduce
  motion → frozen; heading contrast over the frosted panels stayed ≥ 7.7:1 on every preset
  side and style. CPU (2026-10-21, `tauri dev` debug build, muted selftest block `backdrop`,
  WebContent process, 2 s `ps cputime` deltas): 29–30 fps measured in-page; 8–9% with
  `backdrop-filter` on all three panels, 6–7% with no blur at all, 1% paused. That is over
  the 3% budget (plan §7), so `.main` is tinted-translucent without blur (the sidebar and the
  player bar keep theirs); the rest is the canvas itself, so the next lever is the frame cap
  in `controller.ts` (`fps`), not the shaders. A release build and Activity Monitor on an
  M-series Mac have not been read yet. The selftest's `backdrop` block (5 s with blur, 5 s
  without, then paused) writes `selftest_progress` steps a sampler outside the app can key on.
- Backdrop styles (#113, 2026-10-21). The first aurora (thin horizontal ribbons) and grain
  gradient (blurred blobs plus 3% grain at 4 fps) were "not obvious" in use; fluid ink and lava
  blobs stayed. Aurora is now five tall curtains, one swatch each, spread across the width:
  each sheet swings in x along its height (period 17 s, `s = u_time * 0.37`, plus a noise
  wander), has a brighter core, is streaked by fine vertical rays (value noise stretched along
  y, sampled in the sheet's own frame so the streaks bend with it) and fades toward the top
  from a wavy hem. Overlaps average the colours and build coverage (`1 - exp(-wsum * 1.8)`),
  brighter on dark and deeper on light, so nothing blows out on a light surface. The grain
  gradient became "glitch": the palette as 7 posterized bands with a 4×4 Bayer dither and a
  stepped lightness (so a one-colour palette still bands), calm until a burst. Bursts are pure
  functions of `u_time` and `u_mix`, no CPU state: one 0.5 s burst per 5 s slot at a hashed
  offset (2–8 s apart, the same for the same seed), and the track-change cross-fade
  (`u_mix * (1 - u_mix) * 4.4`) is a stronger ~1.4 s one. A burst tears coarse and fine
  horizontal slabs sideways (re-rolled every 1/12 s), jumps some slabs to a neighbouring band,
  splits the channels and flashes 2–6 rectangles of static. `u_still` (the engine passes
  `!drifting`: paused, Still, Reduce motion, hidden) clamps the burst to 0, so a frozen frame is
  never mid-tear and a track change while paused only cross-fades the bands. The style value
  `grain` is accepted and read as `glitch` (`STYLE_ALIASES`, a zod preprocess, schema version
  still 1); the UI and new files only write `glitch`. Both styles run at the common 30 fps cap.
  Shader rule: `hash()` (fract of `p * 456`) runs out of float bits once an input passes a few
  thousand, and the drift clock is unbounded (hours of play), so nothing that grows with
  `u_time` may reach a hash unwrapped. `noise()` wraps its lattice at 256 cells (every corner,
  so the wrap is seamless), which covers ink's and aurora's time-shifted fbm/noise; glitch takes
  its slot and frame counters `mod 512` / `mod 256` (and `mod 64` for the per-pixel static).
  Plain `sin`/`cos` of a large `u_time` (lava, the glitch gradient) are fine. Checked in
  Playwright with `__bcBackdrop.setTime(3600)` and `setTime(10800)`: the static must still
  speckle (pixels with both a brighter and a darker neighbour), not collapse into flat slabs.
  The static's speckle is the band colour pushed 35% toward black or white at 8 Hz, never full
  black/white flicker (photosensitivity).
- Conservative CSS is byte-identical: every rule the backdrop adds to `styles.css` and
  `mini.css` is scoped under `:root:not([data-backdrop="conservative"])`, and the conservative
  mode renders exactly the old DOM (`.ambient > .bg + .wash`). Keep it that way: a new
  frosted-panel, tint or motion rule goes under that scope, never on a bare selector, so
  "Conservative" in Settings stays the look from before #110. The tokens both windows share
  live in `theme/tokens.css`; a token only the main window needs stays in `styles.css`. Outside it `--ambient-1/2` come
  from the boosted swatches, panels are `--panel-alpha` (floored at 0.68 for contrast) over a
  lightly tinted surface (blurred on the sidebar and player bar only, see the CPU figures
  above), `.main` floats with a 12 px margin, headings mix at most 14% toward the accent, and
  the mini window paints `--swatch-1..4`. Under Reduce motion the global
  `animation-duration: 0.01ms` would make an infinite alternating animation flip every frame,
  so the wash drift layers and the `.eq` bars are stopped with `animation: none` there.

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
  and the 10-minute page cache (`cachedFetchText` puts the age cutoff in the query, so a
  stale row's HTML is never read out of the database). Palette art fetches bypass the queue
  on purpose (static CDN, one small image per track change).
- Keep parsing inside `packages/core/src/scrape/`. When markup changes: fix the
  parser, re-save fixtures, `npm test`.
- Schema changes are a new numbered file in `src-tauri/migrations/` plus an entry
  in `src/lib.rs` (and an import in `web/src/api/browserDb.ts`); never edit an applied
  migration, not even a comment (`VersionMismatch`, see above). `albums.owned` mirrors the synced collection (`fan_items`), recomputed in
  one statement; `tracks.stream_quality` is `mp3-v0` or `mp3-128`; `tracks.local_path`
  names a track's offline copy (`<Bandcamp track id>.mp3`, see Offline copies above).
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
- Removing an album, a playlist or a playlist entry offers Undo instead of asking
  first (#93; `web/src/lib/removals.ts`, one note at a time, ~8 s, ⌘Z while it
  shows). Playlists and entries are restored from a snapshot; an album's delete
  waits for the note to go (marked in `settings.key='albums_removing'`, finished on
  window close or at the next start; a private key). A marked album counts as not in
  the library for user imports (search, browse, discography imports; a library-file
  import still counts it as present), and a user import that brings it in again
  unmarks it; a collection sync or a stream refresh never does. A new query listing albums or
  their tracks must add `NOT_REMOVING` (repos/albumRemoval.ts) unless it goes
  through `albumWhere`. By-URL lookups (Browse, Discover, search, a Radio tracklist, Play
  without importing) go through `albums.albumIdsByUrl`, which carries it; a Radio tracklist
  therefore shows no "Open album" for an album in its Undo window (2026-10-21).
  `ConfirmButton` stays for bulk and irreversible actions.
- Crates and Archive (#126, migration 0013, 2026-10-28). A crate (`repos/crates.ts`) is the
  user's own group of albums, separate from Bandcamp's tags; it is listed in the sidebar under
  the playlists and opens the Library's Albums grid narrowed to it (`?crate=<id>`, the
  `crate` condition in `albumWhere`), so Sort, Show, the filter text and the bulk bar apply
  unchanged. Memberships are `crate_albums`; the picker (`cratePicker` in `ui/menu.ts`)
  toggles and stays open; deleting a crate offers Undo from a snapshot. Archive
  (`repos/albumArchive.ts`, `album_archive`) hides an album from the **Albums tab only**: the
  grid, its Recently played row and the bulk bar's track read (`core.albums`/`core.albumTracks`
  pass `archived: "hide"`; `recentlyPlayedAlbums` skips archived). The repo default is `"any"`:
  Artists, Tracks, Tags, Stats, smart playlists (unless the rule's `show` is `archived`),
  playlists, the queue, history, the album page, by-URL lookups and the ⌘K palette (which
  passes `"any"` and says "archived") all keep it. Show → Archived (`AlbumFilter`
  `archived`) lists only archived albums; `unplayed` is albums with no counted play. Both
  are in `SmartRuleSchema.show`. Archiving from a card or the album page offers Undo;
  the bulk bar's Archive all / Unarchive all use `ConfirmButton`. The library file carries
  optional `crates` (by `<library id>:crate:<id>` key, matched by `imported_crates`, then
  the same library's own crate, then a crate of the same name) and `archived` arrays
  (version still 1); both wait by album URL in `crate_albums_pending` /
  `album_archive_pending` and merge in `resolvePending` after each imported album. A file
  only ever marks: it never unarchives or takes an album out of a crate.
- Jobs that are pending, queued or running are "active": `repos/jobs.ts` exports
  `ACTIVE_SQL`/`activeSql(col)` and `activeJob(db, kind, inputUrl?)` (`core.downloadJobFor`
  wraps it) and `types.ts` exports `isActiveJob`, so no query or component spells the three
  statuses out itself. `vacuumOrphans` runs at startup, after removals, once per finished job
  (`JobRunner.process`) and inside `upsertTralbum` only when that write moved tracks out of an
  album, dropped tracks or changed the album's artist; a stream URL refresh on the play path
  no longer sweeps (2026-10-21).
- A plain-key shortcut (`player/shortcuts.ts`) or palette action (`lib/paletteActions.ts`) that
  the menu bar also has runs `runMenuAction(id)` from `lib/appMenu.ts`; add a new action there
  first.
- Navigate from non-React code with `navigateTo()` in `web/src/lib/navigation.ts`;
  never `window.location.assign` (a reload drops the player state).
- Chrome text is unselectable with the arrow cursor inside Tauri; add the
  `selectable` class to any new element whose text people should copy.
- The player store is the only code that touches the audio elements (`audioEls`). UI calls store actions.
- Keep it personal-use: always render the "Buy on Bandcamp" link on album pages.
- The `sqlite3` CLI has foreign keys OFF by default; prefer the app's own
  functions over manual deletes in `library.db` / `library-dev.db`.

## Verifying changes

1. `npm test` and `npm run typecheck`. `npm test` runs both suites; the web one
   (`web/test/`) covers `player/store.ts`, `persist.ts` and `miniBridge.ts` with fake
   timers, a `FakeAudio` element whose events the test fires (`el.emit("pause", { paused: true })`)
   and an in-memory core stub. A fix to the player's event handling, the two-element
   handover or the save timers gets a test there first; the selftest and Playwright
   cover what only a real WebKit element shows (timing, Now Playing). Component tests on
   real timers use `flushAct()` from `test/harness.ts`. `cargo test` in `src-tauri` runs the
   Rust unit tests; the migration-order test's last assertion names the newest migration's
   table, so update it with each new migration.
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
   `VITE_SELFTEST_ONLY=window,dropLink` runs only the named blocks (the rest report
   skipped): a window or config change can be checked without any Bandcamp requests.
   Every block runs through `block()` with its own timeout; while it runs,
   `settings.key='selftest_progress'` names the block and step. If that row stops
   moving, the run is stuck there. A timed-out block reports `{status: "timeout", step}`
   and the run moves on. Hide the main window with `mainWindow.hide()` (the Rust side
   shows it again if the page never does), never with a bare `win.hide()` + `sleep`.
   Verified 2026-10-19: with the display asleep or locked, WebKit treats even a shown
   window as hidden. With only muted media, it then stops running the page: no timers,
   no IPC replies. The run starts with `selftest_window("keep-awake")` to turn that off.
   The selftest plays muted, so `hiddenPlayback` is skipped. Changes to the player,
   background playback or listening history need one
   `VITE_SELFTEST=1 VITE_SELFTEST_AUDIBLE=1 npm run dev` run as well: it is audible
   and takes over Now Playing and the media keys while it runs, so warn the user first.
4. Screenshots of the real window need Screen Recording permission for the
   terminal (`screencapture -l <windowid>`); without it, use browser mode.
5. Release: `npm run build`; open the `.app` from `src-tauri/target/release/bundle/macos/`.

## Backlog

Planned features are GitHub issues labelled `feature`
(https://github.com/zeyuyang42/Campusboard/issues). Check there before
proposing new scope.
