import { fetchQueue } from "./http.js";
import { SearchResponseSchema } from "./schemas.js";
import { ScrapeError } from "./errors.js";
import type { SearchResult, SearchResultType } from "@bc/shared";

const ENDPOINT = "https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic";
const TYPE_MAP: Record<"b" | "a" | "t", SearchResultType> = { b: "band", a: "album", t: "track" };

export async function searchBandcamp(query: string): Promise<Omit<SearchResult, "in_library">[]> {
  const body = JSON.stringify({ search_text: query, search_filter: "", full_page: false, fan_id: null });
  const text = await fetchQueue.fetchText(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body,
  });
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ScrapeError("parse_failed", "Search response was not JSON");
  }
  const res = SearchResponseSchema.safeParse(json);
  if (!res.success) throw new ScrapeError("parse_failed", `Search schema mismatch: ${res.error.issues[0]?.path.join(".")}`);
  return res.data.auto.results.map((r) => ({
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
