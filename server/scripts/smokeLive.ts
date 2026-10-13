// Manual check against a live page: run when imports start failing to see if markup changed.
import { fetchQueue, parseTralbumPage, parseMusicPage } from "../src/scrape/index.js";

const ALBUM = "https://illuminatihotties.bandcamp.com/album/let-me-do-one-more";
const MUSIC = "https://illuminatihotties.bandcamp.com/music";
const a = parseTralbumPage(await fetchQueue.fetchText(ALBUM));
console.log(`album OK: "${a.title}" by ${a.artist.name}, ${a.tracks.length} tracks, ${a.tracks.filter((t) => t.streamable).length} streamable`);
const first = a.tracks.find((t) => t.stream_url);
if (first?.stream_url) {
  const res = await fetch(first.stream_url, { method: "HEAD" });
  console.log(`stream HEAD: ${res.status} ${res.headers.get("content-type")}`);
}
const m = parseMusicPage(await fetchQueue.fetchText(MUSIC), "https://illuminatihotties.bandcamp.com");
console.log(`music OK: ${m.items.length} items, band=${m.band?.name}`);
