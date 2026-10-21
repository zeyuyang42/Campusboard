# CLAUDE.md

@AGENTS.md

## Claude Code specifics

- Before claiming a change works: `npm test`, `npm run typecheck`, then exercise
  the UI in browser mode with Playwright and, for anything touching Tauri plugins
  (database, HTTP, dialogs, fs), run `VITE_SELFTEST=1 npm run dev` and read the
  self-test row from `library-dev.db` (not `library.db`) as described in AGENTS.md.
  Dev runs must never open the installed app's `library.db`. Browser mode is the
  reliable visual check; window screenshots need Screen Recording permission.
- Only one Vite server can own port 5173: stop a browser-mode server before
  `npm run dev`, and stop `tauri dev` before `npm run build` (cargo serialises on
  the target directory anyway).
- Scratch scripts, Playwright installs and screenshots go outside the repo
  (a temp folder), never in it.
- Commit messages: one-line summary, a short body saying why, then the
  `Co-Authored-By` trailer. Do not commit or push unless asked.
- Use `gh` for GitHub (the repo this checkout is cloned from). New planned
  features become issues with the `feature` label rather than TODO comments.
- When something about Bandcamp's pages looks different from the facts listed in
  AGENTS.md, verify with `curl` and `npm run scrape -- <url>` before changing code,
  and update AGENTS.md with the new fact and date.
- Design direction is album-art-forward with restraint: no uppercase eyebrow labels, no middle-dot meta strings, no uniform
  card shadows, no entrance animations. Keep that discipline in new UI.
