/** The single <audio> element used for playback. Wired to the store in store.ts. */
export const audioEl = new Audio();
audioEl.preload = "auto";
audioEl.crossOrigin = null;
// The selftest plays real tracks: muted, so it is silent and, since WebKit never makes a muted
// element Now Playing, never takes the media keys or Control Center from another player.
// Volume 0 would not do: such an element is still Now Playing eligible. WebKit doesn't
// advance muted media in a hidden window, so `hiddenPlayback` is skipped unless
// VITE_SELFTEST_AUDIBLE=1 (audible, and Now Playing and the media keys for the run).
if (import.meta.env.VITE_SELFTEST === "1" && import.meta.env.VITE_SELFTEST_AUDIBLE !== "1") audioEl.muted = true;

// Exposed for diagnostics.
(window as unknown as { __bcAudio?: HTMLAudioElement }).__bcAudio = audioEl;
