// Manual check against live pages: run when imports start failing to see if markup changed.
import { FetchQueue, parseTralbumPage, parseMusicPage } from "../src/scrape/index.js";
const q = new FetchQueue(globalThis.fetch);
const a = parseTralbumPage(await q.fetchText("https://illuminatihotties.bandcamp.com/album/let-me-do-one-more"));
console.log(`album OK: "${a.title}" by ${a.artist.name}, ${a.tracks.length} tracks, ${a.tracks.filter((t) => t.streamable).length} streamable`);
const first = a.tracks.find((t) => t.stream_url);
if (first?.stream_url) { const res = await fetch(first.stream_url, { method: "HEAD" }); console.log(`stream HEAD: ${res.status} ${res.headers.get("content-type")}`); }
const m = parseMusicPage(await q.fetchText("https://illuminatihotties.bandcamp.com/music"), "https://illuminatihotties.bandcamp.com");
console.log(`music OK: ${m.items.length} items, band=${m.band?.name}`);
