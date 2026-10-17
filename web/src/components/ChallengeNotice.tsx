import { clockTime } from "@bc/core";
import { useChallengeUntil } from "../api/queries";

/** Shown while imports wait out a Bandcamp bot-challenge cooldown. */
export function ChallengeNotice({ inline = false }: { inline?: boolean }) {
  const { data: until } = useChallengeUntil();
  if (!until) return null;
  const text = `Paused: Bandcamp asked to slow down, resuming at ${clockTime(until)}`;
  return inline
    ? <div className="muted challenge-paused inline" role="status">{text}</div>
    : <div className="notice challenge-paused" role="status">{text}</div>;
}
