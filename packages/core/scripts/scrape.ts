// Usage: npm run scrape -- <bandcamp url>   (runs under Node, outside the app)
import { normalizeBandcampUrl, parseTralbumPage, parseMusicPage, parseRadioList, parseRadioShow, FetchQueue, ScrapeError } from "../src/scrape/index.js";

const input = process.argv[2];
if (!input) { console.error("usage: npm run scrape -- <bandcamp url>"); process.exit(2); }
const queue = new FetchQueue(globalThis.fetch);
try {
  // Bandcamp Radio: bandcamp.com/radio (the list) or an episode (/radio?show=<id>, /radio/<programme>/<id>).
  const radio = input.match(/^https:\/\/bandcamp\.com\/radio(?:\/[^/?#]+\/(\d+)|\?show=(\d+))?\/?$/);
  if (radio) {
    const html = await queue.fetchText(input);
    const id = radio[1] ?? radio[2];
    console.log(JSON.stringify(id ? parseRadioShow(html) : parseRadioList(html), null, 2));
    process.exit(0);
  }
  const n = normalizeBandcampUrl(input);
  const html = await queue.fetchText(n.url);
  if (n.kind === "artist") console.log(JSON.stringify(parseMusicPage(html, `https://${n.host}`), null, 2));
  else {
    const parsed = parseTralbumPage(html);
    console.log(JSON.stringify(parsed, null, 2));
    console.error(`\n${parsed.tracks.length} tracks, ${parsed.tracks.filter((t) => t.streamable).length} streamable`);
  }
} catch (e) {
  if (e instanceof ScrapeError) { console.error(`[${e.code}] ${e.message}`); process.exit(1); }
  throw e;
}
