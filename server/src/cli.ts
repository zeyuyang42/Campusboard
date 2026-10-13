// Usage: npm run scrape -- <bandcamp url>
import { normalizeBandcampUrl, parseTralbumPage, parseMusicPage, fetchQueue, ScrapeError } from "./scrape/index.js";

const input = process.argv[2];
if (!input) {
  console.error("usage: npm run scrape -- <bandcamp url>");
  process.exit(2);
}
try {
  const n = normalizeBandcampUrl(input);
  const html = await fetchQueue.fetchText(n.url);
  if (n.kind === "artist") {
    const parsed = parseMusicPage(html, `https://${n.host}`);
    console.log(JSON.stringify(parsed, null, 2));
  } else {
    const parsed = parseTralbumPage(html);
    console.log(JSON.stringify(parsed, null, 2));
    console.error(`\n${parsed.tracks.length} tracks, ${parsed.tracks.filter((t) => t.streamable).length} streamable`);
  }
} catch (e) {
  if (e instanceof ScrapeError) {
    console.error(`[${e.code}] ${e.message}`);
    process.exit(1);
  }
  throw e;
}
