import { describe, it, expect } from "vitest";
import { searchBandcamp } from "../src/scrape/search.js";
import { FetchQueue } from "../src/scrape/http.js";

const payload = { auto: { results: [
  { type: "b", id: 1, name: "Band", item_url_root: "https://band.bandcamp.com", item_url_path: null, art_id: null, img: "https://f4.bcbits.com/img/0035886663_23.jpg", location: "LA" },
  { type: "a", id: 2, name: "Album", band_name: "Band", item_url_root: "https://band.bandcamp.com", item_url_path: "https://band.bandcamp.com/album/x?from=search", art_id: 5 },
  { type: "f", id: 3, name: "a fan", item_url_root: "https://bandcamp.com/fan", collection_size: 1 },
  { type: "zz", id: 4, name: "future kind", item_url_root: "https://x.bandcamp.com" },
] } };

describe("searchBandcamp", () => {
  it("keeps bands, albums and tracks and ignores fans and unknown kinds", async () => {
    const queue = new FetchQueue(async () => new Response(JSON.stringify(payload), { status: 200 }), 0);
    const r = await searchBandcamp(queue, "band");
    expect(r.map((x) => x.type)).toEqual(["band", "album"]);
    expect(r[1].url).toBe("https://band.bandcamp.com/album/x");
    expect(r[1].artist).toBe("Band");
  });
});
