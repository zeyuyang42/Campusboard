/** Colors derived from a piece of album art, all as 6-digit hex. */
export interface ArtPalette {
  accent: string;
  ambient1: string;
  ambient2: string;
}
// Extraction lives in extract.ts (added in the palette phase); this file only carries the shared type for now.
