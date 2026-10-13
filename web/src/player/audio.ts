/** The single <audio> element used for playback. Wired to the store in store.ts. */
export const audioEl = new Audio();
audioEl.preload = "auto";
export const audioSrcFor = (trackId: number, force = false) => `/api/tracks/${trackId}/audio?v=${Date.now()}${force ? "&force=1" : ""}`;

// Exposed for diagnostics (e.g. end-to-end tests).
(window as unknown as { __bcAudio?: HTMLAudioElement }).__bcAudio = audioEl;
