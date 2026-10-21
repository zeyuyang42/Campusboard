import { postJson, type FetchQueue } from "./http.js";
import { SearchResponseSchema } from "./schemas.js";
import { ScrapeError } from "./errors.js";
import type { SearchResult, SearchResultType } from "../types.js";

const ENDPOINT = "https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic";
const TYPE_MAP: Record<"b" | "a" | "t", SearchResultType> = { b: "band", a: "album", t: "track" };

export async function searchBandcamp(queue: FetchQueue, query: string): Promise<Omit<SearchResult, "in_library">[]> {
  const json = await postJson((u, i) => queue.fetchText(u, i), ENDPOINT, { search_text: query, search_filter: "", full_page: false, fan_id: null }, "Search");
  const res = SearchResponseSchema.safeParse(json);
  if (!res.success) throw new ScrapeError("parse_failed", `Search schema mismatch: ${res.error.issues[0]?.path.join(".")}`);
  return res.data.auto.results
    .filter((r): r is typeof r & { type: "b" | "a" | "t" } => r.type in TYPE_MAP)
    .map((r) => ({
    type: TYPE_MAP[r.type],
    id: r.id,
    name: r.name,
    artist: r.type === "b" ? null : (r.band_name ?? null),
    // item_url_path is sometimes absolute, sometimes a path, sometimes missing.
    url: (r.item_url_path && /^https?:\/\//.test(r.item_url_path) ? r.item_url_path : `${r.item_url_root}${r.item_url_path ?? ""}`).split("?")[0].replace(/\/+$/, ""),
    art_id: r.art_id ?? null,
    img: r.img ?? null,
    location: r.location ?? null,
  }));
}
