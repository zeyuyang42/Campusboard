import { openUrl } from "@tauri-apps/plugin-opener";

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
        void openUrl(href).catch(() => window.open(href, "_blank", "noopener"));
      }}
    >
      {children}
    </a>
  );
}
