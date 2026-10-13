/** The single <audio> element used for playback. Wired to the store in store.ts. */
export const audioEl = new Audio();
audioEl.preload = "auto";
audioEl.crossOrigin = null;

// Exposed for diagnostics.
(window as unknown as { __bcAudio?: HTMLAudioElement }).__bcAudio = audioEl;
