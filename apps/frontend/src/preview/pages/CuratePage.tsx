import { NavLink } from "react-router-dom";
import { BookOpen, Library, Tags, WandSparkles } from "lucide-react";
import { Books } from "../../features/curator/pages/Books.js";
import { Collections } from "../../features/curator/pages/Collections.js";
import { Tagging } from "../../features/curator/pages/Tagging.js";
import { EncoderPage } from "../../features/curator/features/encoder/pages/EncoderPage.js";

type CurateSection = "books" | "encode" | "collections" | "tags";

const TABS = [
  ["/preview/curate/review", "Books", BookOpen],
  ["/preview/curate/encode", "Needs M4B", WandSparkles],
  ["/preview/curate/collections", "Collections", Library],
  ["/preview/curate/tags", "Tags", Tags],
] as const;

export function CuratePage({ section }: { section: CurateSection }) {
  return (
    <div className="v2-page v2-curate-surface">
      <div className="v2-page-heading v2-curate-heading">
        <div>
          <span className="v2-eyebrow">Curate</span>
          <h1>Shape and refine the library</h1>
          <p>Review metadata, find books that need M4B conversion, and manage tags and collections before pushing changes.</p>
        </div>
        <span className="v2-live"><span className="v2-dot ok"/> Live library</span>
      </div>

      <nav className="v2-section-tabs" aria-label="Curate sections">
        {TABS.map(([to, label, Icon]) => (
          <NavLink key={to} to={to} className={({ isActive }) => isActive ? "active" : ""}>
            <Icon />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>

      <section className="v2-curate-content">
        {section === "books" && <Books basePath="/preview/curate/books" />}
        {section === "encode" && <EncoderPage title="M4B conversion" jobHistoryPath="/preview/curate/encode/jobs" />}
        {section === "collections" && <Collections basePath="/preview/curate/collections" />}
        {section === "tags" && <Tagging />}
      </section>
    </div>
  );
}
