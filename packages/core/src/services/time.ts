// Time text shared by the player bar's hints (resume points, the sleep countdown).

const two = (n: number) => String(n).padStart(2, "0");

/**
 * `m:ss`, or `h:mm:ss` past an hour, for a whole number of seconds (callers round and clamp
 * first). With `hours` false the minutes run on past 59 ("60:00"), for a countdown that is
 * never read as a clock time.
 */
export function clock(wholeSeconds: number, hours = true): string {
  const s = wholeSeconds;
  if (!hours) return `${Math.floor(s / 60)}:${two(s % 60)}`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}
