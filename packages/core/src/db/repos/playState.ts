import type { Db } from "../Db.js";
import { now } from "../Db.js";
import type { PlayState } from "../../types.js";

interface Row { current_track_id: number | null; position_sec: number; queue_json: string; queue_index: number; shuffle: number; repeat: PlayState["repeat"]; volume: number }

export async function getPlayState(db: Db): Promise<PlayState> {
  const r = await db.get<Row>("SELECT * FROM play_state WHERE id = 1");
  if (!r) return { current_track_id: null, position_sec: 0, queue: [], queue_index: 0, shuffle: false, repeat: "off", volume: 1 };
  return { current_track_id: r.current_track_id, position_sec: r.position_sec, queue: JSON.parse(r.queue_json || "[]"), queue_index: r.queue_index, shuffle: !!r.shuffle, repeat: r.repeat, volume: r.volume };
}

export async function setPlayState(db: Db, s: PlayState): Promise<void> {
  await db.run(
    `UPDATE play_state SET current_track_id = ?, position_sec = ?, queue_json = ?, queue_index = ?, shuffle = ?, repeat = ?, volume = ?, updated_at = ? WHERE id = 1`,
    [s.current_track_id, s.position_sec, JSON.stringify(s.queue), s.queue_index, s.shuffle ? 1 : 0, s.repeat, s.volume, now()],
  );
}
