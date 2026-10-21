import { z } from "zod";

// Lenient field schemas for Bandcamp's JSON blobs (radio, discover): a descriptive field
// never rejects an item, anything that isn't the expected type reads as null.
export const str = z.unknown().transform((v) => (typeof v === "string" ? v : null));
export const num = z.unknown().transform((v) => (typeof v === "number" && Number.isFinite(v) ? v : null));

/** The entries of `list` that match `schema`; the others are left out (never the whole list). */
export function items<S extends z.ZodTypeAny>(list: readonly unknown[] | null | undefined, schema: S): z.output<S>[] {
  const out: z.output<S>[] = [];
  for (const x of list ?? []) {
    const r = schema.safeParse(x);
    if (r.success) out.push(r.data);
  }
  return out;
}

export const TrackInfoSchema = z
  .object({
    track_id: z.number(),
    title: z.string(),
    track_num: z.number().nullable().optional(),
    duration: z.number().nullable().optional(),
    artist: z.string().nullable().optional(),
    file: z.record(z.string()).nullable().optional(),
    streaming: z.number().nullable().optional(),
    lyrics: z.string().nullable().optional(),
    has_lyrics: z.boolean().nullable().optional(),
    title_link: z.string().nullable().optional(),
  })
  .passthrough();

export const TralbumSchema = z
  .object({
    id: z.number(),
    item_type: z.enum(["album", "track"]),
    artist: z.string(),
    art_id: z.number().nullable().optional(),
    url: z.string(),
    album_release_date: z.string().nullable().optional(),
    is_preorder: z.union([z.boolean(), z.number()]).nullable().optional(),
    // Only used to pick where a preview starts: a surprising value must never fail the parse.
    featured_track_id: z.number().nullable().optional().catch(null),
    current: z
      .object({
        title: z.string(),
        band_id: z.number(),
        about: z.string().nullable().optional(),
        credits: z.string().nullable().optional(),
        release_date: z.string().nullable().optional(),
        album_id: z.number().nullable().optional(),
      })
      .passthrough(),
    trackinfo: z.array(TrackInfoSchema),
  })
  .passthrough();

export const LdJsonSchema = z.object({ keywords: z.array(z.string()).optional() }).passthrough();

export const BandSchema = z
  .object({ id: z.number(), name: z.string(), url: z.string().optional(), subdomain: z.string().optional() })
  .passthrough();

export const SearchResponseSchema = z.object({
  auto: z.object({
    results: z.array(
      z
        .object({
          // b = band/label, a = album, t = track, f = fan profile; new kinds may appear, so accept any string.
          type: z.string(),
          id: z.number(),
          name: z.string(),
          band_name: z.string().nullable().optional(),
          band_id: z.number().nullable().optional(),
          item_url_root: z.string(),
          item_url_path: z.string().nullable().optional(),
          art_id: z.number().nullable().optional(),
          img: z.string().nullable().optional(),
          location: z.string().nullable().optional(),
        })
        .passthrough(),
    ),
  }),
});
