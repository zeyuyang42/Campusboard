import type { Db } from "../connection.js";
import { now } from "../connection.js";
import type { PlayState } from "@bc/shared";

export function getPlayState(db: Db): PlayState {
  const r = db.prepare("SELECT * FROM play_state WHERE id = 1").get() as unknown as {
    current_track_id: number | null; position_sec: number; queue_json: string; queue_index: number; shuffle: number; repeat: PlayState["repeat"]; volume: number;
  };
  return {
    current_track_id: r.current_track_id,
    position_sec: r.position_sec,
    queue: JSON.parse(r.queue_json || "[]"),
    queue_index: r.queue_index,
    shuffle: !!r.shuffle,
    repeat: r.repeat,
    volume: r.volume,
  };
}

export function setPlayState(db: Db, s: PlayState): void {
  db.prepare(
    `UPDATE play_state SET current_track_id = ?, position_sec = ?, queue_json = ?, queue_index = ?, shuffle = ?, repeat = ?, volume = ?, updated_at = ? WHERE id = 1`,
  ).run(s.current_track_id, s.position_sec, JSON.stringify(s.queue), s.queue_index, s.shuffle ? 1 : 0, s.repeat, s.volume, now());
}
