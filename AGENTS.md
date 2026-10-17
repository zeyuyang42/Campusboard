# Working in this repo

Personal Bandcamp player, shipped as a Tauri 2 macOS app. Single user, no auth.
TypeScript for everything except the thin Rust shell. Read `README.md` for what
it does; this file is about how to change it safely.

## Commands

```bash
npm install                      # Node 22.5+, Rust 1.90+, Xcode CLT
npm run dev                      # tauri dev: Vite :5173 + the app window (hot reload)
npm run build                    # tauri build -> src-tauri/target/release/bundle/{macos,dmg}
npm test                         # vitest in packages/core, offline, uses node:sqlite + saved HTML fixtures
npm run typecheck                # core + web
VITE_BROWSER_MODE=1 npm run web:dev   # UI in a normal browser: sql.js + Vite fetch middleware, in-memory data
VITE_SELFTEST=1 npm run dev      # app runs web/src/selftest.ts and writes results to settings.key='selftest'
npm run scrape -- <url>          # print what the parser sees (Node)
npm run fixtures:save -- <url> <name>   # refresh packages/core/test/fixtures/<name>.html
npm run smoke:live               # re-parse one known live page
```

## Layout

```
packages/core/src/
  types.ts                 DTOs shared by core and web (import "@bc/core")
  scrape/                  ALL Bandcamp parsing. url, http (FetchQueue, injected fetch), parseTralbum, parseMusic, search, schemas
  db/Db.ts                 async Db interface {select,get,run}; SQL uses "?" and toDollar() rewrites to $n for the Tauri plugin
  db/repos/                one module per table; booleans stored 0/1, converted at the repo boundary
  services/                importService (upsertTralbum, vacuumOrphans), streamService, jobRunner, pageCache
  theme/                   schema (zod), presets, color math (OKLCH, contrast), apply (CSS variables)
  palette/                 quantize + pick + extract (canvas) + fitPalette + artUrl
  core.ts                  createCore({db, fetch, onJobsChange}) -> every function the UI calls
packages/core/test/        vitest; helpers/nodeDb.ts runs src-tauri/migrations/*.sql on node:sqlite
web/src/
  api/core.ts              getCore() singleton; Tauri plugins, or browserDb.ts when VITE_BROWSER_MODE=1
  api/queries.ts           TanStack Query hooks and mutations (names are stable; pages depend on them)
  player/store.ts          zustand store owning the single <audio>; load() asks core for a fresh stream URL
  theme/store.ts           theme state, persisted in settings.key='theme'; usePalette.ts maps art colors to CSS vars
  ui/menu.ts + components/MenuHost.tsx   the one context menu / playlist picker for the whole app
  components/, pages/      plain CSS in styles.css driven by tokens on :root
src-tauri/
  src/lib.rs               registers sql/http/dialog/fs/opener/window-state plugins, migrations, Dock reopen
  src/menu.rs              native menu bar; custom items emit a `menu` event handled by web/src/lib/appMenu.ts
  migrations/*.sql         schema; every statement is IF NOT EXISTS so an old library.db can be adopted
  capabilities/default.json  URL scope for http (bandcamp.com, bcbits.com, custom-domain paths; LAN denied), fs scope ($APPDATA), window permissions
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
- Search `item_url_path` may be absolute or relative; album `img` from search
  lacks the `a` prefix real art URLs need (derive from `art_id`).
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
  `valuesList()`; playlist append computes positions inside one INSERT.
- WKWebView supports `@property`, `color-mix`, `oklch`, `OffscreenCanvas` from
  macOS 13.3, hence the minimum version.
- `core:window:default` does not include `allow-start-dragging`, so the
  `data-tauri-drag-region` band only works because the capability file grants
  it explicitly, along with hide/show/minimize/toggle-maximize/set-focus.
- Window behaviour follows Music.app: closing hides the window and playback
  continues (`persist.ts` prevents the close and calls `hide()`), the Dock icon
  reopens it (`RunEvent::Reopen` in lib.rs), Cmd+Q quits. Menu accelerators use
  Cmd so they never fight text fields; plain-key shortcuts stay in `shortcuts.ts`.

## Rules

- Be polite to Bandcamp: keep `FetchQueue` serial at 1 req/s with the browser UA
  and the 10-minute page cache. Palette art fetches bypass the queue on purpose
  (static CDN, one small image per track change).
- Keep parsing inside `packages/core/src/scrape/`. When markup changes: fix the
  parser, re-save fixtures, `npm test`.
- Schema changes are a new numbered file in `src-tauri/migrations/` plus an entry
  in `src/lib.rs`; never edit an applied migration. Columns `albums.owned`,
  `tracks.stream_quality`, `tracks.local_path` are reserved for planned features.
- Theme files are data: `applyTheme` only ever calls `style.setProperty`. Never
  interpolate theme values into CSS text. New theme fields go through
  `ThemeSchema` with bounds, and bump `version` only for breaking changes.
- No `window.prompt`/`confirm`/`alert`: WKWebView handles them badly. Use inline
  inputs and `ConfirmButton`.
- Navigate from non-React code with `navigateTo()` in `web/src/lib/navigation.ts`;
  never `window.location.assign` (a reload drops the player state).
- Chrome text is unselectable with the arrow cursor inside Tauri; add the
  `selectable` class to any new element whose text people should copy.
- The player store is the only code that touches `audioEl`. UI calls store actions.
- Keep it personal-use: always render the "Buy on Bandcamp" link on album pages.
- The `sqlite3` CLI has foreign keys OFF by default; prefer the app's own
  functions over manual deletes in `library.db`.

## Verifying changes

1. `npm test` and `npm run typecheck`.
2. UI: run `VITE_BROWSER_MODE=1 npm run web:dev` and drive it with Playwright
   (installed outside the repo). Launch Chromium with
   `--autoplay-policy=no-user-gesture-required`; `window.__bcAudio` exposes the
   audio element. Full-page navigation resets the in-memory database, so navigate
   through the sidebar links. Vite proxies Bandcamp at `/bc-proxy/<encoded url>`.
3. Runtime: `VITE_SELFTEST=1 npm run dev`, then read
   `SELECT value FROM settings WHERE key='selftest'` from
   `~/Library/Application Support/com.bandcampplayer.app/library.db`.
   Extend `web/src/selftest.ts` when adding features that touch Tauri plugins.
4. Screenshots of the real window need Screen Recording permission for the
   terminal (`screencapture -l <windowid>`); without it, use browser mode.
5. Release: `npm run build`; open the `.app` from `src-tauri/target/release/bundle/macos/`.

## Backlog

Planned features are GitHub issues labelled `feature`
(https://github.com/zeyuyang42/bandcamp-player/issues). Check there before
proposing new scope.
