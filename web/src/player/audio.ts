/** The single <audio> element used for playback. Wired to the store in store.ts. */
export const audioEl = new Audio();
audioEl.preload = "auto";
audioEl.crossOrigin = null;
// The selftest plays real tracks: muted, so it is silent and, since WebKit never makes a muted
// element Now Playing, never takes the media keys or Control Center from another player.
// WebKit doesn't advance muted media in a hidden window, so the `hiddenPlayback` measurement
// needs VITE_SELFTEST_AUDIBLE=1 (audible, and Now Playing for the run).
if (import.meta.env.VITE_SELFTEST === "1" && import.meta.env.VITE_SELFTEST_AUDIBLE !== "1") audioEl.muted = true;

// Exposed for diagnostics.
(window as unknown as { __bcAudio?: HTMLAudioElement }).__bcAudio = audioEl;
