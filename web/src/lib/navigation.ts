// Router access for code that lives outside React (menu bridge, shortcuts).
// AppShell registers the navigator once it has mounted inside the router.
type Navigator = (to: string | number) => void;
let navigator: Navigator | null = null;

export function setNavigator(fn: Navigator | null) { navigator = fn; }

/** Navigate without a page reload; `to` may be a path or a history delta. */
export function navigateTo(to: string | number) {
  if (navigator) navigator(to);
  else if (typeof to === "string") window.location.assign(to);
}

/** Focus the search box if it is on screen, otherwise go to the Search page (which autofocuses it). */
export function focusSearch() {
  const el = document.querySelector<HTMLInputElement>("[data-search-input]");
  if (el) { el.focus(); el.select(); } else navigateTo("/search");
}

/** `/` and Find: the Library's filter field when it is on screen, otherwise the search box. */
export function focusFind() {
  const el = document.querySelector<HTMLInputElement>("[data-library-filter]");
  if (el) { el.focus(); el.select(); } else focusSearch();
}

/** The Library's album grid narrowed to one tag (#71). */
export const libraryTagPath = (tag: string) => `/library/albums?tag=${encodeURIComponent(tag)}`;
