import { openExternal } from "../lib/openExternal";

/** Opens the URL in the user's default browser (the app window never navigates away). */
export function ExternalLink({ href, className, children, title }: { href: string; className?: string; children: React.ReactNode; title?: string }) {
  return (
    <a
      href={href}
      className={className}
      title={title}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openExternal(href);
      }}
    >
      {children}
    </a>
  );
}
