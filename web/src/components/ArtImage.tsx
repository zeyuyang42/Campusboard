import { artUrl, radioImageUrl, type ArtSize } from "@bc/core";

/** Album art by `artId`; `imageId` (a radio episode's image, no "a" prefix) is the fallback. */
export function ArtImage({ artId, imageId, size = 16, alt = "", className }: { artId: number | null | undefined; imageId?: number | null; size?: ArtSize; alt?: string; className?: string }) {
  const src = artUrl(artId, size) ?? radioImageUrl(imageId, size);
  if (!src) return <div className={className} aria-hidden="true" />;
  return <img className={className} src={src} alt={alt} loading="lazy" decoding="async" />;
}
