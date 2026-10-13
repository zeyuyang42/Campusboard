/** Bandcamp art CDN sizes: 7 = 160px thumb, 16 = 700px, 10 = 1200px, 2 = 350px. */
export type ArtSize = 7 | 2 | 16 | 10;
export function artUrl(artId: number | null | undefined, size: ArtSize = 16): string | null {
  if (!artId) return null;
  return `https://f4.bcbits.com/img/a${String(artId).padStart(10, "0")}_${size}.jpg`;
}
