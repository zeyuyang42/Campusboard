import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * Open a link in the user's default browser (the app window never navigates away). Falls back to
 * `window.open` in browser mode, where the opener plugin has nothing to talk to.
 */
export function openExternal(href: string): void {
  void openUrl(href).catch(() => window.open(href, "_blank", "noopener"));
}
