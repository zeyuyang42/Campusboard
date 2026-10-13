// Usage: npm run fixtures:save -- <url> <name>
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchQueue, normalizeBandcampUrl } from "../src/scrape/index.js";

const [url, name] = process.argv.slice(2);
if (!url || !name) {
  console.error("usage: npm run fixtures:save -- <url> <name>");
  process.exit(2);
}
const n = normalizeBandcampUrl(url);
const html = await fetchQueue.fetchText(n.url);
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", `${name}.html`);
writeFileSync(out, html);
console.log(`saved ${html.length} bytes to ${out}`);
