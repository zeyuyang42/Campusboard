import type { Db } from "../Db.js";
import { now } from "../Db.js";
import type { PlayState } from "../../types.js";
import { getSetting, setSetting } from "./settings.js";

interface Row { current_track_id: number | null; position_sec: number; queue_json: string; queue_index: number; shuffle: number; repeat: PlayState["repeat"]; volume: number }

/**
 * settings key: how play_state.volume is to be read (services/volume.ts). Kept beside the
 * table rather than in a new column so no migration is needed (a build without an applied
 * migration refuses the library); a missing key means version 0, the linear gain.
 */
export const VOLUME_VERSION_KEY = "play_state_volume_version";

export async function getPlayState(db: Db): Promise<PlayState> {
  const r = await db.get<Row>("SELECT * FROM play_state WHERE id = 1");
  const version = (await getSetting<number>(db, VOLUME_VERSION_KEY)) ?? 0;
  if (!r) return { current_track_id: null, position_sec: 0, queue: [], queue_index: 0, shuffle: false, repeat: "off", volume: 1, volume_version: version };
  return { current_track_id: r.current_track_id, position_sec: r.position_sec, queue: JSON.parse(r.queue_json || "[]"), queue_index: r.queue_index, shuffle: !!r.shuffle, repeat: r.repeat, volume: r.volume, volume_version: version };
}

export async function setPlayState(db: Db, s: PlayState): Promise<void> {
  // The version goes first: interrupted in between, an old gain is read as a position, which
  // plays quieter (p^3 <= p), never louder. The next save writes the position anyway.
  await setSetting(db, VOLUME_VERSION_KEY, s.volume_version);
  await db.run(
    `UPDATE play_state SET current_track_id = ?, position_sec = ?, queue_json = ?, queue_index = ?, shuffle = ?, repeat = ?, volume = ?, updated_at = ? WHERE id = 1`,
    [s.current_track_id, s.position_sec, JSON.stringify(s.queue), s.queue_index, s.shuffle ? 1 : 0, s.repeat, s.volume, now()],
  );
}
