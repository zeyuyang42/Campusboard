import { z } from "zod";

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
    featured_track_id: z.number().nullable().optional(),
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
export type Tralbum = z.infer<typeof TralbumSchema>;

export const LdJsonSchema = z.object({ keywords: z.array(z.string()).optional() }).passthrough();

export const BandSchema = z
  .object({ id: z.number(), name: z.string(), url: z.string().optional(), subdomain: z.string().optional() })
  .passthrough();

export const ClientItemSchema = z.object({ page_url: z.string() }).passthrough();

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
