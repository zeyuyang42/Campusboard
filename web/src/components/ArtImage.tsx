import { artUrl, type ArtSize } from "../lib/art";

export function ArtImage({ artId, size = 16, alt = "", className }: { artId: number | null | undefined; size?: ArtSize; alt?: string; className?: string }) {
  const src = artUrl(artId, size);
  if (!src) return <div className={className} aria-hidden="true" />;
  return <img className={className} src={src} alt={alt} loading="lazy" decoding="async" />;
}
