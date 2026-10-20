import { Link } from "react-router-dom";
import { useUi } from "../ui/store";
import { libraryTagPath } from "../lib/navigation";

/**
 * An album's Bandcamp tags as plain links into the Library grid narrowed to that tag (#71).
 * Following one clears the Library's filter text so the whole tag shows.
 */
export function TagLinks({ tags: raw }: { tags: string[] }) {
  // Trimmed and de-duplicated, as the Tags tab groups them.
  const tags = [...new Set(raw.map((t) => t.trim()).filter(Boolean))];
  const setQ = useUi((s) => s.setLibraryQuery);
  if (!tags.length) return null;
  return (
    <div className="tags" aria-label="Tags">
      {tags.map((t) => <Link className="tag" key={t} to={libraryTagPath(t)} onClick={() => setQ("")}>{t}</Link>)}
    </div>
  );
}
