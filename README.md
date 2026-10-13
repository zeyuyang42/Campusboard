# Bandcamp Player

A personal, local-only web UI for listening to Bandcamp. Paste an album, track or
artist link; it lands in your library; curate playlists; play in a clean player
with keyboard shortcuts and Mac media keys.

Bandcamp has no public API, so the server reads the JSON that Bandcamp embeds in
its own album pages (the same data the official player uses) and streams audio
straight from Bandcamp's CDN at 128 kbps. Nothing is downloaded or re-hosted.
Every album page keeps a **Buy on Bandcamp** link. Bandcamp's terms allow
personal, non-commercial use. Please buy what you keep coming back to.

## Run it

Requires Node 22.5+ (uses the built-in `node:sqlite`; developed on Node 25).

```bash
npm install
npm run build
npm start          # http://localhost:3001
```

Development mode with hot reload (server on 3001, UI on 5173):

```bash
npm run dev        # open http://localhost:5173
```

The library lives in `data/library.db` (SQLite). Delete it to start over.

## Using it

- **Import**: paste `https://artist.bandcamp.com/album/...`, `/track/...`, or an
  artist URL (imports the whole discography, one page per second).
- **Search**: searches Bandcamp directly; "Add" imports a result.
- **Playlists**: use the `···` menu on any track or album. Drag rows to reorder.
- **Queue**: press `Q`. Playback position and queue survive restarts.

Shortcuts: `Space` play/pause · `←`/`→` seek 5 s · `Shift+←`/`→` prev/next ·
`↑`/`↓` volume · `S` shuffle · `R` repeat · `Q` queue · `/` search.

## How it works

```
web/      Vite + React + zustand + TanStack Query   (the UI)
server/   Hono + node:sqlite                        (API, scraping, job queue)
shared/   TypeScript types shared by both
```

- `server/src/scrape/` parses Bandcamp pages. `parseTralbum.ts` reads the
  `data-tralbum` attribute on album/track pages; `parseMusic.ts` reads an
  artist's `/music` page; `search.ts` wraps Bandcamp's autocomplete endpoint.
  All HTTP goes through `http.ts`, a serial queue limited to one request per
  second with a normal browser User-Agent.
- Stream URLs expire about 24 hours after a page is fetched. The `<audio>`
  element points at `/api/tracks/:id/audio`, which 302-redirects to a fresh CDN
  URL, re-scraping the album page when needed. The player retries once with
  `force=1` if a stream errors.
- Imports run as background jobs (`jobs` / `job_items` tables) so a 100-release
  discography can trickle in without blocking the UI.

## Checks

```bash
npm test             # parser + import tests against saved HTML fixtures (offline)
npm run smoke        # API smoke test against a running server
npm run smoke:live   # re-parse a known live page; run this if imports start failing
npm run scrape -- <bandcamp url>        # print what the parser sees
npm run fixtures:save -- <url> <name>   # refresh a test fixture after Bandcamp changes markup
```

If Bandcamp changes its markup, imports fail with `parse_failed` and the server
log shows which field is missing. Fix the parser, re-save fixtures, re-run tests.

## Not in v1 (schema leaves room)

Syncing purchased items with your Bandcamp login (higher-quality streams),
offline caching, remote access/PWA, custom artist domains.
