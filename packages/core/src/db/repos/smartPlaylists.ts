// Smart playlists (#84): a playlist whose tracks are a saved rule, evaluated through the
// Library's own filters (albumWhere, the album sorts, listAlbumTracks) every time it is opened
// or played. The rule lives in smart_playlists.rule_json; playlist_tracks stays empty for it.
import { z } from "zod";
import type { Db } from "../Db.js";
import { now } from "../Db.js";
import { ALBUM_SORTS, albumTracksSummary, listAlbumTracks } from "./albums.js";
import { RATING_MAX } from "./albumNotes.js";
import type { Track } from "../../types.js";

export const SMART_TEXT_MAX = 200;
export const SMART_DAYS_MAX = 3650;
export const SMART_LIMIT_MAX = 10_000;

/**
 * A smart playlist's rule. Unknown keys are dropped. Every criterion narrows the albums (a
 * play of any of an album's tracks counts for it); `limit` then keeps the first tracks in
 * sort order.
 */
export const SmartRuleSchema = z.object({
  /** Archived albums (#126) count like any other here unless show is "archived" (then only they match). */
  show: z.enum(["all", "purchased", "wishlist", "downloaded", "rated", "archived", "unplayed"]).default("all"),
  /** 0 for any rating. */
  minRating: z.number().int().min(0).max(RATING_MAX).default(0),
  tag: z.string().trim().max(SMART_TEXT_MAX).optional(),
  text: z.string().trim().max(SMART_TEXT_MAX).optional(),
  playedWithinDays: z.number().int().min(1).max(SMART_DAYS_MAX).optional(),
  notPlayedWithinDays: z.number().int().min(1).max(SMART_DAYS_MAX).optional(),
  sort: z.enum(ALBUM_SORTS).default("added"),
  limit: z.number().int().min(1).max(SMART_LIMIT_MAX).optional(),
});

export type SmartRule = z.infer<typeof SmartRuleSchema>;
export type SmartRuleInput = z.input<typeof SmartRuleSchema>;

/** Thrown by createSmartPlaylist/setSmartRule for a rule outside the bounds. */
export class SmartRuleError extends Error {
  readonly code = "invalid_smart_rule";
  constructor(message = "This rule isn't valid.") {
    super(message);
    this.name = "SmartRuleError";
  }
}

/** The validated rule with empty text and tag left out, or null when it is invalid. */
export function parseSmartRule(raw: unknown): SmartRule | null {
  const r = SmartRuleSchema.safeParse(raw);
  if (!r.success) return null;
  const { tag, text, ...rest } = r.data;
  return { ...rest, ...(tag ? { tag } : {}), ...(text ? { text } : {}) };
}

/** parseSmartRule over stored JSON; a damaged row reads as null (an empty smart playlist). */
export function parseRuleJson(json: string | null | undefined): SmartRule | null {
  if (!json) return null;
  try {
    return parseSmartRule(JSON.parse(json));
  } catch {
    return null;
  }
}

export function requireRule(rule: unknown): SmartRule {
  const r = parseSmartRule(rule);
  if (!r) throw new SmartRuleError();
  return r;
}

const args = (r: SmartRule) => [r.sort, r.show, r.text ?? "", r.tag ?? "", {
  minRating: r.minRating, playedWithinDays: r.playedWithinDays, notPlayedWithinDays: r.notPlayedWithinDays, limit: r.limit,
}] as const;

/** The rule's tracks right now, in order. Unstreamable tracks are included, as in any playlist. */
export function evaluateSmartRule(db: Db, rule: SmartRule): Promise<Track[]> {
  return listAlbumTracks(db, ...args(rule));
}

/** How many tracks the rule matches right now (after its limit), and up to four art ids for a cover. */
export function summarizeSmartRule(db: Db, rule: SmartRule): Promise<{ track_count: number; art_ids: number[] }> {
  return albumTracksSummary(db, ...args(rule));
}

/**
 * Replace a smart playlist's rule. False for an ordinary playlist (or none): a rule is only
 * ever given at creation (createSmartPlaylist), so an ordinary playlist never turns smart.
 */
export async function setSmartRule(db: Db, playlistId: number, rule: unknown): Promise<boolean> {
  const r = requireRule(rule);
  const done = await db.run("UPDATE smart_playlists SET rule_json = ? WHERE playlist_id = ?", [JSON.stringify(r), playlistId]);
  if (!done.changes) return false;
  await db.run("UPDATE playlists SET updated_at = ? WHERE id = ?", [now(), playlistId]);
  return true;
}

/** The playlist's rule, or null when it is an ordinary playlist (or its rule is damaged). */
export async function getSmartRule(db: Db, playlistId: number): Promise<SmartRule | null> {
  const row = await db.get<{ rule_json: string }>("SELECT rule_json FROM smart_playlists WHERE playlist_id = ?", [playlistId]);
  return parseRuleJson(row?.rule_json);
}
