// npm run dev:copy-library [-- --force]
// Snapshot the installed app's library.db into library-dev.db (what debug builds open), to try a
// branch against real data. The source is opened read-only and is never migrated or written:
// VACUUM INTO writes a consistent copy even while the app is running.
import { DatabaseSync } from "node:sqlite";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = join(homedir(), "Library", "Application Support", "com.bandcampplayer.app");
const src = join(dir, "library.db");
const dest = join(dir, "library-dev.db");
const force = process.argv.includes("--force");

if (!existsSync(src)) {
  console.error(`No library.db in ${dir}: nothing to copy.`);
  process.exit(1);
}
if (existsSync(dest)) {
  if (!force) {
    console.error("library-dev.db already exists. Stop any dev run and pass --force to replace it.");
    process.exit(1);
  }
  for (const f of [dest, `${dest}-wal`, `${dest}-shm`]) rmSync(f, { force: true });
}

const db = new DatabaseSync(src, { readOnly: true });
try {
  const top = db.prepare("SELECT MAX(version) AS v FROM _sqlx_migrations").get();
  db.prepare("VACUUM INTO ?").run(dest);
  console.log(`Copied library.db (schema version ${top?.v ?? "?"}) to library-dev.db.`);
  console.log("The next `npm run dev` applies this branch's migrations to the copy only.");
} finally {
  db.close();
}
