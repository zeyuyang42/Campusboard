// Usage: npm run fixtures:save -- <url> <name>
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FetchQueue, normalizeBandcampUrl } from "../src/scrape/index.js";
import { scrubFixture } from "../test/helpers/scrubFixture.js";

const [url, name] = process.argv.slice(2);
if (!url || !name) { console.error("usage: npm run fixtures:save -- <url> <name>"); process.exit(2); }
// Other people's names and the visitor's country never reach the repo (scrubFixture).
const html = scrubFixture(await new FetchQueue(globalThis.fetch).fetchText(normalizeBandcampUrl(url).url));
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", `${name}.html`);
writeFileSync(out, html);
console.log(`saved ${html.length} bytes to ${out}`);
