import { Link } from "react-router-dom";

import { useLibraryHealth, useRecentlyAdded } from "../../features/curator/api.js";

type HealthData = { health?: Record<string, { status: string }>; totals?: { books: number; completeMetadata: number; m4b: number; structureIssues: number | null; duplicates: number } };

export function LibraryHealthDetails({ data }: { data: HealthData | undefined }) {
  const health = data?.health ?? {};
  const totals = data?.totals;
  const rows = [
    ["Metadata in ABS", health.metadata?.status ?? "Unknown", totals ? `${totals.completeMetadata}/${totals.books}` : ""],
    ["M4B files", health.files?.status ?? "Unknown", health.files?.status === "Unknown" ? "not measured" : totals ? `${totals.m4b}/${totals.books}` : ""],
    ["Structure", health.structure?.status ?? "Unknown", totals?.structureIssues != null ? `${totals.structureIssues} misaligned` : "not measured"],
    ["Duplicates", health.duplicates?.status ?? "Unknown", totals ? `${totals.duplicates} found` : ""],
  ];
  return <div className="v2-library-health-details">{rows.map(([label, status, detail]) => <div key={label}><span>{label}</span><span>{detail} <strong>{status}</strong></span></div>)}</div>;
}

export function LibraryHealthSummary() {
  const health = useLibraryHealth();
  return <section className="v2-library-health-summary" aria-label="Library health summary">
    <h3>Library health</h3>
    <p>{health.isPending ? "Checking your library…" : health.isError ? "Library health could not be read." : `${health.data?.overallScore ?? "Unknown"} overall score`}</p>
    {health.data && <LibraryHealthDetails data={health.data} />}
    <Link to="/library/manage/health">View full report</Link>
  </section>;
}

export function RecentlyAddedBooks() {
  const recentlyAdded = useRecentlyAdded();
  const books = recentlyAdded.data?.results ?? [];
  return <section className="v2-library-recent" aria-labelledby="library-recent-heading" style={{ marginTop: "2rem" }}>
    <h2 id="library-recent-heading" style={{ fontSize: "1.25rem", marginBottom: "1rem" }}>Recently added</h2>
    {recentlyAdded.isLoading && <p role="status">Loading recently added books…</p>}
    {recentlyAdded.isError && <p role="alert">Recently added books could not be loaded.</p>}
    {!recentlyAdded.isLoading && !recentlyAdded.isError && books.length === 0 && <p>No recently added books found.</p>}
    {books.length > 0 && <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "1rem" }}>{books.map((book: { id: string; title: string; author?: string | null; coverUrl?: string | null; addedAt?: string | number }) => <article key={book.id} style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      <div style={{ aspectRatio: "1/1.5", background: "var(--bg-card)", borderRadius: "6px", overflow: "hidden" }}>{book.coverUrl ? <img src={book.coverUrl} alt={book.title} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : null}</div>
      <Link to={`/library/books/${encodeURIComponent(book.id)}`} style={{ fontWeight: 600, fontSize: "0.9rem" }}>{book.title}</Link>
      <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>{book.author ?? "Unknown author"}</span>
      {book.addedAt != null && <time style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{new Date(book.addedAt).toLocaleDateString()}</time>}
    </article>)}</div>}
  </section>;
}
