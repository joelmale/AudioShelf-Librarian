import { NavLink } from "react-router-dom";
import { BookOpen, Library, Tags, WandSparkles } from "lucide-react";
import React from "react";

const Books = React.lazy(async () => ({ default: (await import("../../features/curator/pages/Books.js")).Books }));
const Collections = React.lazy(async () => ({ default: (await import("../../features/curator/pages/Collections.js")).Collections }));
const Tagging = React.lazy(async () => ({ default: (await import("../../features/curator/pages/Tagging.js")).Tagging }));
const EncoderPage = React.lazy(async () => ({ default: (await import("../../features/curator/features/encoder/pages/EncoderPage.js")).EncoderPage }));

type CurateSection = "books" | "encode" | "collections" | "tags";

const TABS = [
  ["/curate/review", "Books", BookOpen],
  ["/curate/encode", "Needs M4B", WandSparkles],
  ["/curate/collections", "Collections", Library],
  ["/curate/tags", "Tags", Tags],
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
        <React.Suspense fallback={<div className="v2-route-loading" role="status">Loading curation tools…</div>}>
          {section === "books" && <Books basePath="/curate/books" />}
          {section === "encode" && <EncoderPage title="M4B conversion" jobHistoryPath="/curate/encode/jobs" />}
          {section === "collections" && <Collections basePath="/curate/collections" />}
          {section === "tags" && <Tagging />}
        </React.Suspense>
      </section>
    </div>
  );
}
