import { usePlayer } from "../player/store";
import { Seek } from "./Seek";

/** The player bar's seek control, bound to the store. */
export function SeekBar() {
  const position = usePlayer((s) => s.position);
  const duration = usePlayer((s) => s.duration);
  const seek = usePlayer((s) => s.seek);
  return <Seek className="seek" position={position} duration={duration} onSeek={seek} />;
}
