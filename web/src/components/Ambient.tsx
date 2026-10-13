/** Fixed layer behind the shell: optional background image, then the album-art wash. */
export function Ambient() {
  return (
    <div className="ambient" aria-hidden="true">
      <div className="bg" />
      <div className="wash" />
    </div>
  );
}
