/** True when running inside the Tauri window (false in browser-only dev mode). */
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
