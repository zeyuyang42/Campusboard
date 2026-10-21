import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "../src/db/Db.js";
import * as jobs from "../src/db/repos/jobs.js";
import { decodeEntities } from "../src/scrape/html.js";
import type { Job } from "../src/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
/** A saved Bandcamp page (test/fixtures/<name>.html). */
export const fixture = (name: string) => readFileSync(path.join(here, "fixtures", `${name}.html`), "utf8");
/** A saved API answer (test/fixtures/<name>.json), as the text Bandcamp sent. */
export const jsonFixture = (name: string) => readFileSync(path.join(here, "fixtures", `${name}.json`), "utf8");

/** Poll a job until it is neither queued nor running (up to about two seconds). */
export async function waitJob(db: Db, id: number): Promise<Job> {
  for (let i = 0; i < 400; i++) {
    const j = (await jobs.getJob(db, id))!;
    if (j.status !== "queued" && j.status !== "running") return j;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("job did not finish");
}

/** A fan page's data-blob, as JSON, for edits. */
export type Blob = Record<string, any>;

/** The fan page fixture with its data-blob edited. */
export function fanPage(edit: (b: Blob) => void = () => {}): string {
  const html = fixture("fan");
  const m = html.match(/data-blob="([^"]*)"/)!;
  const b = JSON.parse(decodeEntities(m[1])) as Blob;
  edit(b);
  const attr = JSON.stringify(b).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return html.replace(m[0], `data-blob="${attr}"`);
}

/** Edit: the page as Bandcamp serves it to the signed-in owner of the collection. */
export const loggedInAsFan = (b: Blob) => { b.identities.fan = { id: b.fan_data.fan_id, username: b.fan_data.username }; b.fan_data.is_own_page = true; };
