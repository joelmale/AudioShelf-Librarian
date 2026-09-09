import { NavLink } from "react-router-dom";
import { BookOpen, Library, ListOrdered } from "lucide-react";
import React from "react";
import { api, useHealth, useMutation } from "../../features/curator/api.js";
import { useToast } from "../../features/curator/toast.js";
import { LibraryHealthSummary, RecentlyAddedBooks } from "./LibrarySummary.js";

const Books = React.lazy(async () => ({ default: (await import("../../features/curator/pages/Books.js")).Books }));
const Collections = React.lazy(async () => ({ default: (await import("../../features/curator/pages/Collections.js")).Collections }));
const MetadataPipeline = React.lazy(async () => ({ default: (await import("../../features/curator/pages/MetadataPipeline.js")).MetadataPipeline }));
const EncoderPage = React.lazy(async () => ({ default: (await import("../../features/curator/features/encoder/pages/EncoderPage.js")).EncoderPage }));
const RealignPage = React.lazy(async () => ({ default: (await import("./RealignPage.js")).RealignPage }));

export type LibrarySection = "books" | "collections" | "manage" | "metadata" | "files" | "audio";
type LegacyCurateSection = "encode" | "realign" | "tags";

const TABS = [
  ["/library/books", "Books", BookOpen],
  ["/library/collections", "Collections", Library],
  ["/library/manage", "Manage library", ListOrdered],
] as const;

export function CuratePage({ section }: { section: LibrarySection | LegacyCurateSection }) {
  return (
    <div className="v2-page v2-curate-surface">
      <div className="v2-page-heading v2-curate-heading">
        <div>
          <span className="v2-eyebrow">Library</span>
          <h1>Browse and manage your library</h1>
          <p>Review metadata, find books that need M4B conversion, run the metadata pipeline, and manage collections before pushing changes.</p>
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
          {section === "books" && <><RecentlyAddedBooks /><Books basePath="/library/books" /></>}
          {section === "encode" || section === "audio" ? <EncoderPage title="M4B conversion" jobHistoryPath="/library/manage/audio/jobs" /> : null}
          {section === "collections" && <Collections basePath="/library/collections" />}
          {section === "realign" || section === "files" ? <RealignPage /> : null}
          {section === "tags" || section === "metadata" ? <MetadataPipeline /> : null}
          {section === "manage" && <ManageLibrary />}
        </React.Suspense>
      </section>
    </div>
  );
}

function ManageLibrary() {
  const health = useHealth();
  const toast = useToast();
  const sync = useMutation({ mutationFn: api.sync, onSuccess: () => toast("Pulling library from Audiobookshelf", "success"), onError: (error: Error) => toast(error.message, "error") });
  return <section className="v2-library-manage" aria-label="Manage library">
    <h2>Manage library</h2>
    <p>Open a focused tool for library health, metadata, file organization, or audio conversion.</p>
    <div className="v2-library-manage-links">
      <NavLink to="/library/manage/metadata">Metadata</NavLink>
      <NavLink to="/library/manage/files">File organization</NavLink>
      <NavLink to="/library/manage/audio">Audio conversion</NavLink>
      <NavLink to="/library/manage/health">Library health</NavLink>
    </div>
    <LibraryHealthSummary />
    <section className="v2-library-sync-summary" aria-label="Audiobookshelf sync">
      <h3>Audiobookshelf</h3>
      <p>{health.data?.absConnected ? "Connected. Pull changes into the local mirror when you choose." : "Connection needs attention before a sync can run."}</p>
      <button type="button" className="v2-button v2-success" disabled={sync.isPending || !health.data?.absConnected} onClick={() => sync.mutate()}>
        {sync.isPending ? "Syncing…" : "Sync from Audiobookshelf"}
      </button>
    </section>
  </section>;
}
