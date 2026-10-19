<p align="center">
  <img src="docs/icon.png" width="128" alt="Bandcamp Player icon">
</p>

<h1 align="center">Bandcamp Player</h1>

<p align="center">A personal Mac app for listening to Bandcamp. Paste a link, keep a library, make playlists, and play in a player that takes its colors from the album art.</p>

<p align="center"><a href="https://github.com/zeyuyang42/bandcamp-player/releases/latest"><b>Download the latest release</b></a> (macOS, Apple Silicon)</p>

![Library](docs/library.png)

![Now playing](docs/now-playing.png)

Bandcamp has no public API, so the app reads the JSON that Bandcamp embeds in
its own album pages (the same data the official player uses) and streams audio
straight from Bandcamp's CDN at 128 kbps. Nothing is downloaded or re-hosted.
Every album page keeps a **Buy on Bandcamp** link. Bandcamp's terms allow
personal, non-commercial use. Please buy what you keep coming back to.

## Install (macOS, Apple Silicon)

1. Download the `.dmg` from the [releases page](https://github.com/zeyuyang42/bandcamp-player/releases/latest), open it, and drag **Bandcamp Player** to Applications.
2. The app is not signed with an Apple Developer ID, so the first time macOS
   will refuse to open it. Right-click the app, choose **Open**, and confirm.
   If that option is missing, go to System Settings → Privacy & Security and
   click **Open Anyway**. You only need to do this once.

Requires macOS 13.3 or later. Your library lives in
`~/Library/Application Support/com.bandcampplayer.app/library.db`.

## Using it

- **Import**: paste `https://artist.bandcamp.com/album/...` or `/track/...`.
  An artist or label URL opens a browse page listing every release with
  checkboxes, so you import only what you want (or everything). Imports run one
  page per second and resume after a restart.
- **Search**: searches Bandcamp directly; "Add" imports an album or track,
  "Browse releases" opens an artist's or label's page.
- **Your collection**: Settings → Bandcamp account. Enter your username and press
  **Sync now** to import what you've bought and your wishlist (public collections
  need nothing else); the Library's **Show** menu filters to Purchased or Wishlist.
  Optionally paste the `identity` cookie from a browser where you're logged in to
  bandcamp.com to include a private collection and stream your purchases as MP3 V0.
  The cookie stays in your local library database and is only sent to bandcamp.com.
  While the app is open it also syncs on its own, at most once a day and only when
  no import is running (turn this off in the same section). An automatic sync
  doesn't re-send a cookie Bandcamp rejected; it reads the public lists instead.
- **New releases**: while the app is open it looks at one library artist's
  Bandcamp page every few minutes (each artist at most once a day) and lists
  releases that appeared since its first look, to import or dismiss. Turn it off
  or press **Check now** in Settings; mute an artist from their page.
- **Playlists**: right-click any track or album, or select several tracks
  (click, Shift-click, Cmd-click) and use the bar that appears. Drag rows to
  reorder.
- **Filtered library**: when the filter field or the **Show** menu narrows the
  Library, a bar above the grid plays, shuffles, queues or adds to a playlist
  every matching album in the current sort order (it asks first above 500 tracks).
- **Now playing**: press `N` or click the artwork in the dock for a full view
  with queue and lyrics.
- **Mini player**: Window → Mini Player (`⌘⇧M`) or the mini player button in
  the dock opens a small window that stays on top of other apps (the pin
  button turns that off), with the artwork, the track, a seek bar and the
  transport controls. The square button switches to a large-artwork layout.
  It keeps working with the main window closed.
- **Menu bar icon**: Settings → When the window is closed (off by default)
  adds an icon to the menu bar with the current track, Play/Pause, Next,
  Previous, Show Window and Quit.
- **Track notifications**: Settings → When the window is closed (off by
  default) shows a notification with the track, artist and album when the
  track changes while the window is closed or in the background.
- **Gapless and crossfade**: Settings → Playback. The next track loads in the
  background and starts as the current one ends (on by default). Crossfade
  (off by default, up to 10 s) blends tracks from different albums; tracks of
  the same album always play back to back as recorded.
- **Themes**: Settings → pick a preset (including High contrast), follow the
  system appearance or pin dark or light, adjust colors, fonts, corner radius,
  density, the album-art wash and an optional background image. Export writes a
  `.theme.json` you can send to a friend; Import loads one.
- **Moving to another Mac**: Settings → Library. Export library writes a JSON
  file with your albums (by Bandcamp address), playlists, listening history,
  theme and settings, never your identity cookie. Import library on the other
  Mac shows what's new, then fetches the missing albums from Bandcamp at the
  usual pace and fills the playlists in as they arrive. Back up library
  database saves a complete copy of the library file at any time.

Closing the window keeps the music playing; click the Dock icon to bring it
back, and press `⌘Q` to quit. The current track shows in Control Center's Now
Playing, and the keyboard's media keys and AirPods control playback, with the
window open or closed. The menu-bar Now Playing item appears when the window is
hidden or in the background (macOS hides it while the app is in front). The window remembers its size and position.

Shortcuts: `Space` play/pause, `←`/`→` seek 5 s, `Shift+←`/`→` previous/next,
`↑`/`↓` volume, `S` shuffle, `R` repeat, `Q` queue, `N` now playing,
`/` search, `Esc` close. The menu bar adds `⌘1`–`⌘4` for the main pages,
`⌘F` find, `⌘I` import, `⌘N` new playlist, `⌘,` settings and `⌘`-based
playback controls; the full list is in Settings → Keyboard shortcuts.

## Theme files

A theme is a JSON file validated on import. Only colors, fonts, numbers and an
https image URL are accepted; a theme cannot contain CSS or scripts, so a shared
theme can't break the app. Example:

```json
{
  "version": 1,
  "name": "Dusk",
  "mode": "dark",
  "palette": { "surface": "#23262D", "surfaceRaised": "#2C3038", "text": "#F1EEE9",
               "textMuted": "#9A9AA6", "accent": "#5BB6D1", "danger": "#E06A5E" },
  "radius": 10,
  "density": "comfortable",
  "fonts": { "display": "Bricolage Grotesque Variable", "ui": "Instrument Sans Variable" },
  "ambient": 0.6,
  "background": { "source": "none", "value": "", "blur": 12, "dim": 0.5 }
}
```

`accent` is only used when nothing is playing; while a track plays, the accent
and the backdrop come from its artwork, clamped so text stays readable.

`mode` is `"dark"`, `"light"` or `"system"`. A system theme follows the Mac's
appearance as it changes and needs both sides as `paletteDark` and
`paletteLight` (same keys as `palette`); every preset carries the pair, so
choosing Settings → Base → Match system keeps the preset's colors. New
libraries start on Dusk following the system. `"contrast": "high"` (the High
contrast preset) holds the art-derived accent to WCAG AAA (7:1). Version 0.4
and earlier refuse a `"system"` file; dark and light files with a pair import
there, since unknown keys are dropped.

## Development

Requires Node 22.5+, Rust 1.90+ and Xcode command line tools.

```bash
npm install
npm run dev          # Tauri window with hot reload (Vite on :5173)
npm run build        # .app and .dmg in src-tauri/target/release/bundle/
npm test             # core (parser, data layer, theme, palette) and web player tests (offline)
npm run typecheck
```

Browser-only mode for UI work and screenshots (same code, SQLite in WebAssembly,
Bandcamp pages fetched through a Vite middleware):

```bash
VITE_BROWSER_MODE=1 npm run web:dev   # http://localhost:5173
```

```
packages/core/   parsers, async Db interface, repos, services, theme + palette engines
web/             React UI (Vite); binds core to Tauri's SQLite + HTTP plugins
src-tauri/       Rust shell: plugins, migrations, capabilities, bundle config
```

- `packages/core/src/scrape/` parses Bandcamp pages. `parseTralbum.ts` reads the
  `data-tralbum` attribute on album/track pages; `parseMusic.ts` reads an
  artist's `/music` page; `search.ts` wraps Bandcamp's autocomplete endpoint.
  All HTTP goes through `FetchQueue`, serial at one request per second with a
  normal browser User-Agent.
- Stream URLs expire about 24 hours after a page is fetched; the player asks
  core for a fresh URL before each play and retries once on a media error.
- `npm run scrape -- <url>` prints what the parser sees; `npm run smoke:live`
  re-parses a known page. If Bandcamp changes its markup, imports fail with
  `parse_failed`; fix the parser, re-save fixtures with `npm run fixtures:save`,
  re-run tests.

## Not yet

Syncing purchased items with your Bandcamp login (higher-quality streams),
offline caching, Windows/Linux builds,
custom artist domains. Tracked as issues labelled `feature`.
