import { artUrl } from "../lib/art";

/** 2x2 mosaic of a playlist's first distinct album arts. */
export function PlaylistCover({ artIds, size = "md" }: { artIds: number[]; size?: "sm" | "md" }) {
  const ids = artIds.slice(0, 4);
  const one = ids.length < 4;
  const shown = one ? ids.slice(0, 1) : ids;
  return (
    <div className={`pl-cover ${one ? "one" : ""} ${size === "sm" ? "sm" : ""}`} aria-hidden="true">
      {shown.length === 0 ? <span /> : shown.map((id, i) => <img key={`${id}-${i}`} src={artUrl(id, 7) ?? ""} alt="" loading="lazy" />)}
    </div>
  );
}
