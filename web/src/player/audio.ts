/**
 * The two <audio> elements used for playback (#35): one plays the current track, the other
 * preloads the next one for a gapless switch or a crossfade, and they trade places at each
 * transition. Only the player store (store.ts) touches them; other code asks the store.
 */
const make = () => {
  const el = new Audio();
  el.preload = "auto";
  el.crossOrigin = null;
  // The selftest plays real tracks: muted, so it is silent and, since WebKit never makes a muted
  // element Now Playing, never takes the media keys or Control Center from another player.
  // Volume 0 would not do: such an element is still Now Playing eligible. WebKit doesn't
  // advance muted media in a hidden window, so `hiddenPlayback` is skipped unless
  // VITE_SELFTEST_AUDIBLE=1 (audible, and Now Playing and the media keys for the run).
  if (import.meta.env.VITE_SELFTEST === "1" && import.meta.env.VITE_SELFTEST_AUDIBLE !== "1") el.muted = true;
  return el;
};

export const audioEls: readonly [HTMLAudioElement, HTMLAudioElement] = [make(), make()];
