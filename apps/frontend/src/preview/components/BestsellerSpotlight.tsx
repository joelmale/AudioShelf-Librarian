import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, ChevronLeft, ChevronRight, Headphones, Search } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  BESTSELLER_SOURCES,
  aggregateBestsellers,
  buildBestsellerSearchQuery,
  consensusKey,
  descriptionToPlainText,
  useBestsellerCharts,
  type AggregatedBestseller,
  type BestsellerBook,
} from "../../features/librarian/components/BestsellerLists.js";
import "./BestsellerSpotlight.css";

function SpotlightCover({ book, featured = false }: { book: BestsellerBook; featured?: boolean }) {
  const [failedUrl, setFailedUrl] = useState<string>();
  return (
    <span className="v2-spotlight-cover" aria-hidden="true">
      {book.coverUrl && book.coverUrl !== failedUrl
        ? <img src={book.coverUrl} alt="" loading={featured ? "eager" : "lazy"} onError={() => setFailedUrl(book.coverUrl)} />
        : <Headphones />}
    </span>
  );
}

function chartLabel({ appearances }: AggregatedBestseller) {
  if (appearances.length > 1) return `On ${appearances.length} bestseller charts`;
  const [{ source, rank }] = appearances;
  return `#${rank} on ${BESTSELLER_SOURCES.find((chart) => chart.id === source)?.label ?? source}`;
}

function bookAnchor(book: BestsellerBook) {
  return `spotlight-${encodeURIComponent(consensusKey(book))}`;
}

function searchHref(book: BestsellerBook) {
  const params = new URLSearchParams({
    q: buildBestsellerSearchQuery(book),
    returnTo: `/discover#${bookAnchor(book)}`,
  });
  return `/discover/search?${params}`;
}

export function BestsellerSpotlight() {
  const { lists, sources, loading, error } = useBestsellerCharts();
  const { pathname, search, hash, state } = useLocation();
  const navigate = useNavigate();
  const restoredAnchor = useRef("");
  const picks = useMemo(() => {
    const libraryMatches = new Set(
      Object.values(lists).flatMap((books) =>
        (books ?? []).filter((book) => book.ownership === "owned" || book.ownership === "possible" || book.isFinished).map(consensusKey),
      ),
    );
    return aggregateBestsellers(lists).filter(({ book }) => !libraryMatches.has(consensusKey(book))).slice(0, 5);
  }, [lists]);
  const selectedAnchor = (state as { spotlightAnchor?: string } | null)?.spotlightAnchor ?? hash.slice(1);
  const featuredIndex = Math.max(0, picks.findIndex(({ book }) => bookAnchor(book) === selectedAnchor));
  const featured = picks[featuredIndex];
  const more = picks.filter((_, index) => index !== featuredIndex).slice(0, 3);
  const description = featured ? descriptionToPlainText(featured.book.description) : "";
  const pitch = description.length > 300 ? `${description.slice(0, 300).replace(/\s+\S*$/, "")}…` : description;

  function moveSpotlight(offset: number) {
    const next = (featuredIndex + offset + picks.length) % picks.length;
    navigate({ pathname, search, hash }, {
      replace: true,
      preventScrollReset: true,
      state: { ...state, spotlightAnchor: bookAnchor(picks[next].book) },
    });
  }

  useEffect(() => {
    if (!hash.startsWith("#spotlight-")) {
      restoredAnchor.current = "";
      return;
    }
    if (restoredAnchor.current === hash || selectedAnchor !== hash.slice(1)) return;
    const link = document.getElementById(selectedAnchor);
    if (link) {
      link.focus();
      link.scrollIntoView?.({ block: "nearest" });
      restoredAnchor.current = hash;
    }
  }, [hash, selectedAnchor, featured]);

  const sourceStatuses = Object.values(sources ?? {});
  const unavailable = error || (sourceStatuses.length > 0 &&
    sourceStatuses.every(({ status }) => status === "failed" || status === "not-configured"));
  const cached = error || (sourceStatuses.some(({ status }) => status === "stale") &&
    sourceStatuses.every(({ status }) => status !== "ready"));

  return (
    <div className="v2-spotlight">
      {!featured ? (
        <div className="v2-spotlight-empty">
          {loading ? <p role="status">Loading bestsellers…</p> : <p role="status">
            {unavailable ? "Bestsellers are temporarily unavailable." : "There are no new chart picks to feature right now."}
          </p>}
          <Link to="/discover/search" className="v2-button v2-button-secondary"><Search size={16} aria-hidden="true" /> Search sources</Link>
        </div>
      ) : <>
        {cached && <p className="v2-spotlight-notice" role="status">Showing cached bestseller picks.</p>}
        <article className="v2-spotlight-hero" aria-labelledby="spotlight-book-title">
          {picks.length > 1 && <div className="v2-spotlight-controls" role="group" aria-label="Browse featured bestsellers">
            <button type="button" className="v2-icon-button" aria-label="Previous featured audiobook" onClick={() => moveSpotlight(-1)}>
              <ChevronLeft size={20} aria-hidden="true" />
            </button>
            <span>{featuredIndex + 1} of {picks.length}</span>
            <button type="button" className="v2-icon-button" aria-label="Next featured audiobook" onClick={() => moveSpotlight(1)}>
              <ChevronRight size={20} aria-hidden="true" />
            </button>
          </div>}
          <div className="v2-spotlight-copy">
            <p className="v2-eyebrow">{chartLabel(featured)}</p>
            <h2 id="spotlight-book-title" aria-live="polite">{featured.book.title}</h2>
            <p className="v2-spotlight-author">{featured.book.author}</p>
            {pitch && <p className="v2-spotlight-pitch">{pitch}</p>}
            <Link id={bookAnchor(featured.book)} to={searchHref(featured.book)} className="v2-button">
              <Search size={17} aria-hidden="true" /> Find audiobook
            </Link>
          </div>
          <div className="v2-spotlight-art"><SpotlightCover book={featured.book} featured /></div>
        </article>
        {more.length > 0 && <section aria-labelledby="spotlight-more-title">
          <h2 id="spotlight-more-title">More chart favorites</h2>
          <ul className="v2-spotlight-picks">
            {more.map(({ book }) => <li key={consensusKey(book)}>
              <Link id={bookAnchor(book)} to={searchHref(book)} aria-label={`Find audiobook for ${book.title} by ${book.author}`}>
                <SpotlightCover book={book} />
                <span className="v2-spotlight-pick-copy"><strong>{book.title}</strong><span>{book.author}</span></span>
                <ArrowRight size={16} aria-hidden="true" />
              </Link>
            </li>)}
          </ul>
        </section>}
      </>}
    </div>
  );
}
