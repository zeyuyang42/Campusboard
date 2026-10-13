# CLAUDE.md

@AGENTS.md

## Claude Code specifics

- Before claiming a change works: `npm test`, `npm run typecheck`, then exercise
  the UI in browser mode with Playwright and, for anything touching Tauri plugins
  (database, HTTP, dialogs, fs), run `VITE_SELFTEST=1 npm run dev` and read the
  self-test row as described in AGENTS.md. Chrome browser tools and window
  screenshots may be unavailable in this environment; browser mode is the
  reliable visual check.
- Only one Vite server can own port 5173: stop a browser-mode server before
  `npm run dev`, and stop `tauri dev` before `npm run build` (cargo serialises on
  the target directory anyway).
- Scratch scripts, Playwright installs and screenshots go in the session
  scratchpad, never in the repo.
- Commit messages: one-line summary, a short body saying why, then the
  `Co-Authored-By` trailer. Do not commit or push unless asked.
- Use `gh` for GitHub (repo `zeyuyang42/bandcamp-player`, private). New planned
  features become issues with the `feature` label rather than TODO comments.
- When something about Bandcamp's pages looks different from the facts listed in
  AGENTS.md, verify with `curl` and `npm run scrape -- <url>` before changing code,
  and update AGENTS.md with the new fact and date.
- Design direction is album-art-forward with restraint (see the plan's design
  pass): no uppercase eyebrow labels, no middle-dot meta strings, no uniform
  card shadows, no entrance animations. Keep that discipline in new UI.
