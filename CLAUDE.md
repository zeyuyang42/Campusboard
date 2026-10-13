# CLAUDE.md

@AGENTS.md

## Claude Code specifics

- Before claiming a change works, run `npm test`, then `npm run build && npm start`
  and `npm run smoke` against it. For player or UI changes, also drive the built app
  with a headless Playwright script as described in AGENTS.md; Chrome browser tools
  may be unavailable in this environment.
- Scratch scripts, Playwright installs and screenshots go in the session scratchpad,
  never in the repo.
- Commit messages: one-line summary, a short body saying why, then the
  `Co-Authored-By` trailer. Do not commit or push unless asked.
- Use `gh` for GitHub (repo `zeyuyang42/bandcamp-player`, private). New planned
  features become issues with the `feature` label rather than TODO comments.
- When something about Bandcamp's pages looks different from the facts listed in
  AGENTS.md, verify with `curl` and `npm run scrape -- <url>` before changing code,
  and update AGENTS.md with the new fact and date.
