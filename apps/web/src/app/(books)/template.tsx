/**
 * Re-mounts on each navigation, so every page arrives with a short fade and
 * rise (PEN-208 motion). Reduced motion makes it instant (globals.css).
 */
export default function BooksTemplate({ children }: { children: React.ReactNode }) {
  return <div className="dl-page">{children}</div>;
}
