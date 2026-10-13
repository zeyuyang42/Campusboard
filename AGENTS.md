# Working in this repo

Personal, local-only Bandcamp player. Single user, no auth. TypeScript end to end.
Read `README.md` for what it does; this file is about how to change it safely.

## Commands

```bash
npm install                 # once; Node 22.5+ (uses built-in node:sqlite, no native builds)
npm run dev                 # server :3001 (tsx watch) + Vite :5173 with /api proxy
npm run build && npm start  # production: one process on :3001 serving web/dist + /api
npm test                    # vitest, offline, against server/test/fixtures/*.html
npm run smoke               # curl API script; needs a running server on :3001
npm run smoke:live          # re-parse one known live Bandcamp page (manual, not CI)
npm run scrape -- <url>     # print what the parser sees for an album/track/artist URL
npm run fixtures:save -- <url> <name>   # refresh server/test/fixtures/<name>.html
```

Type-check without building: `npx tsc -p server/tsconfig.json --noEmit` and
`npx tsc -p web/tsconfig.json --noEmit`.

## Layout

```
shared/src/types.ts        DTOs shared by server and web (import as "@bc/shared", types only)
server/src/
  config.ts                ports, paths, rate limit, User-Agent
  scrape/                  ALL Bandcamp parsing lives here and nowhere else
    url.ts                 normalizeBandcampUrl -> {kind: album|track|artist, url}
    http.ts                FetchQueue: serial, 1 req/s, retries; every Bandcamp request goes through it
    parseTralbum.ts        album/track page -> ParsedTralbum (reads data-tralbum + ld+json)
    parseMusic.ts          artist /music page -> item URLs (+ data-client-items)
    search.ts              autocomplete_elastic wrapper
    schemas.ts             zod schemas; passthrough, strict only on required keys
  db/                      node:sqlite; migrations embedded in migrations.ts; repos/ hold SQL
  services/
    importService.ts       upsertTralbum: idempotent write of a parsed page (one transaction)
    streamService.ts       getFreshStreamUrl: re-scrape album when stream URL near expiry
    jobRunner.ts           in-process queue over jobs/job_items (discography imports)
  routes/                  Hono routes, thin; errors via ScrapeError / HttpError -> {error:{code,message}}
web/src/
  api/                     fetch client + TanStack Query hooks (invalidate via useInvalidateLibrary)
  player/                  store.ts (zustand) owns the single <audio>; audio.ts, persist.ts,
                           mediaSession.ts, shortcuts.ts are wiring only
  pages/, components/      plain CSS in styles.css, no UI framework
```

## Facts that shape the design (verified 2026-10-13)

- Bandcamp has no public API. Album/track pages embed `data-tralbum` JSON with
  `mp3-128` stream URLs. yt-dlp reads the same attribute; treat it as the contract.
- Stream URLs expire ~24h after fetch (`ts=` query param). Never hand a stored
  URL to the client directly: `GET /api/tracks/:id/audio` 302-redirects to a fresh
  one and the browser talks to the CDN itself (Range requests work).
- Bandcamp pages send no CORS headers, so page fetches must happen server-side.
- `item_url_path` from search can be absolute or relative; album `img` from search
  lacks the `a` prefix real art URLs need (derive from `art_id` instead).
- Art URL: `https://f4.bcbits.com/img/a{art_id padded to 10}_{size}.jpg`
  (`_7` thumb, `_16` 700px, `_10` 1200px).
- A `/track/` page imports as an `albums` row with `item_type='track'`; `track_id`
  is globally unique, so importing the full album later re-parents the track and
  the pseudo-album is deleted. Importing a `/track/` page whose track already lives
  in a real album only refreshes stream fields (see importService tests).

## Rules

- Be polite to Bandcamp: keep the 1 req/s limit, the browser User-Agent, and the
  10-minute page cache. Do not add parallel fetching.
- Keep parsing inside `server/src/scrape/`. When Bandcamp markup changes, fix the
  parser, re-save fixtures, re-run `npm test`. Do not special-case markup in routes
  or services.
- Any schema change is a new entry in `server/src/db/migrations.ts` with the next
  version number; never edit an applied migration. Columns `albums.owned`,
  `tracks.stream_quality`, `tracks.local_path` are reserved for planned features.
- Repos return plain objects; booleans are stored as 0/1 and converted at the repo
  boundary (`rowToAlbum`, `rowToTrack`).
- `data/` is gitignored; never commit a database or fixtures containing cookies.
- Node's `node:sqlite` has no `.transaction()` helper; use `tx(db, fn)` from
  `db/connection.ts`. The `sqlite3` CLI has foreign keys OFF by default; manual
  deletes can orphan rows and rowid reuse re-attaches them. Prefer the API.
- The player store is the only thing allowed to touch `audioEl`. UI components
  call store actions.
- Keep it personal-use: always render the "Buy on Bandcamp" link on album pages.

## Verifying UI changes

There is no browser test in the repo. A Playwright script works well: launch
Chromium with `--autoplay-policy=no-user-gesture-required`, click a track's
number button, then read `window.__bcAudio.currentTime` (exposed by
`web/src/player/audio.ts`). Install Playwright outside the repo (e.g. a temp
directory), not as a project dependency.

## Backlog

Planned features are GitHub issues labelled `feature`
(https://github.com/zeyuyang42/bandcamp-player/issues). Check there before
proposing new scope.
