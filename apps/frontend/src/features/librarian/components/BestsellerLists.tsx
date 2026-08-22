import React, { useEffect, useMemo, useRef, useState } from "react";
import { Info, X } from "lucide-react";

import "./BestsellerLists.css";

export type BestsellerSource =
  | "audible"
  | "audiobooksnow"
  | "apple"
  | "nyt-fiction"
  | "nyt-nonfiction";

export interface BestsellerBook {
  title: string;
  author: string;
  coverUrl: string;
  description: string;
  source: BestsellerSource;
}

interface BestsellersResponse {
  results?: {
    audible?: BestsellerBook[];
    audiobooksnow?: BestsellerBook[];
    apple?: BestsellerBook[];
    nytFiction?: BestsellerBook[];
    nytNonfiction?: BestsellerBook[];
  };
}

export const BESTSELLER_SOURCES: Array<{
  id: BestsellerSource;
  responseKey: keyof NonNullable<BestsellersResponse["results"]>;
  label: string;
  shortLabel: string;
}> = [
  { id: "audible", responseKey: "audible", label: "Audible", shortLabel: "Audible" },
  { id: "audiobooksnow", responseKey: "audiobooksnow", label: "AudiobooksNow", shortLabel: "ABN" },
  { id: "apple", responseKey: "apple", label: "Apple Books", shortLabel: "Apple" },
  { id: "nyt-fiction", responseKey: "nytFiction", label: "NYT Fiction", shortLabel: "NYT Fic" },
  { id: "nyt-nonfiction", responseKey: "nytNonfiction", label: "NYT Nonfiction", shortLabel: "NYT Nonfic" },
];

const ALL_TAB_ID = "all" as const;
type TabId = typeof ALL_TAB_ID | BestsellerSource;

export interface AggregatedBestseller {
  book: BestsellerBook;
  appearances: Array<{ source: BestsellerSource; rank: number }>;
}

interface DescriptionOverlay {
  bookKey: string;
  loading: boolean;
  pinned: boolean;
  text: string;
  x: number;
  y: number;
}

const DESCRIPTION_OVERLAY_ID = "bestseller-description-overlay";
const NO_DESCRIPTION = "No description available.";

const bookKey = (book: BestsellerBook) =>
  `${book.source}:${book.title}:${book.author}`;

const collapseWhitespace = (value: string) =>
  value.replace(/\s+/g, " ").trim();

export function descriptionToPlainText(description: string): string {
  if (!description.trim()) return "";

  if (typeof DOMParser !== "undefined") {
    const document = new DOMParser().parseFromString(description, "text/html");
    document
      .querySelectorAll("script, style, noscript, template")
      .forEach((element) => element.remove());
    return collapseWhitespace(document.body.textContent ?? "");
  }

  return collapseWhitespace(description.replace(/<[^>]*>/g, " "));
}

export function buildBestsellerSearchQuery(book: BestsellerBook): string {
  const mainTitle = book.title.split(":")[0].trim();
  return `${mainTitle} ${book.author}`.trim();
}

/**
 * Chart entries for the same book differ in subtitle punctuation, edition
 * suffixes like "(Unabridged)", and author formatting between sources, so
 * match on the main title plus the first author's last name rather than the
 * exact strings.
 */
export function consensusKey(book: BestsellerBook): string {
  const mainTitle = book.title
    .replace(/\([^)]*\)/g, "")
    .split(":")[0]
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const firstAuthor = book.author.split(/,|&| and /i)[0].trim();
  const lastName = (firstAuthor.split(/\s+/).pop() ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return `${mainTitle}|${lastName}`;
}

/**
 * Merge every source's chart into one consensus ranking: titles appearing on
 * more charts first, ties broken by the best single-chart rank.
 */
export function aggregateBestsellers(
  lists: Partial<Record<BestsellerSource, BestsellerBook[]>>,
): AggregatedBestseller[] {
  const merged = new Map<string, AggregatedBestseller>();

  for (const { id } of BESTSELLER_SOURCES) {
    (lists[id] ?? []).forEach((book, index) => {
      const key = consensusKey(book);
      const appearance = { source: id, rank: index + 1 };
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { book, appearances: [appearance] });
        return;
      }
      if (existing.appearances.some((entry) => entry.source === id)) return;
      existing.appearances.push(appearance);
      // Prefer the representative copy that actually has artwork/description.
      if (!existing.book.coverUrl && book.coverUrl) {
        existing.book = { ...existing.book, coverUrl: book.coverUrl };
      }
      if (!existing.book.description && book.description) {
        existing.book = { ...existing.book, description: book.description };
      }
    });
  }

  return [...merged.values()].sort((left, right) => {
    if (right.appearances.length !== left.appearances.length) {
      return right.appearances.length - left.appearances.length;
    }
    const bestRank = (entry: AggregatedBestseller) =>
      Math.min(...entry.appearances.map((appearance) => appearance.rank));
    if (bestRank(left) !== bestRank(right)) return bestRank(left) - bestRank(right);
    return left.book.title.localeCompare(right.book.title);
  });
}

export const BestsellerLists: React.FC = () => {
  const [lists, setLists] = useState<Partial<Record<BestsellerSource, BestsellerBook[]>>>({});
  const [activeTab, setActiveTab] = useState<TabId>(ALL_TAB_ID);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [descriptionCache, setDescriptionCache] = useState<
    Record<string, string>
  >({});
  const [overlay, setOverlay] = useState<DescriptionOverlay | null>(null);
  const tabRefs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({});

  useEffect(() => {
    const controller = new AbortController();

    const fetchBestsellers = async () => {
      try {
        const response = await fetch("/api/librarian/bestsellers", {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Failed to fetch bestsellers");

        const data = (await response.json()) as BestsellersResponse;
        const next: Partial<Record<BestsellerSource, BestsellerBook[]>> = {};
        for (const { id, responseKey } of BESTSELLER_SOURCES) {
          const books = data.results?.[responseKey];
          next[id] = Array.isArray(books) ? books : [];
        }
        setLists(next);
      } catch (fetchError: unknown) {
        if (fetchError instanceof Error && fetchError.name === "AbortError") {
          return;
        }
        setError(
          fetchError instanceof Error
            ? fetchError.message
            : "Failed to load bestsellers",
        );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    void fetchBestsellers();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const closePinnedOverlay = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOverlay(null);
    };

    window.addEventListener("keydown", closePinnedOverlay);
    return () => window.removeEventListener("keydown", closePinnedOverlay);
  }, []);

  const aggregated = useMemo(() => aggregateBestsellers(lists), [lists]);

  const handleSearch = (book: BestsellerBook) => {
    window.dispatchEvent(
      new CustomEvent("trigger-audiobook-search", {
        detail: { query: buildBestsellerSearchQuery(book) },
      }),
    );
  };

  const showDescription = async (
    book: BestsellerBook,
    x: number,
    y: number,
    pinned: boolean,
  ) => {
    if (!pinned && overlay?.pinned) return;

    const key = bookKey(book);
    const suppliedDescription = descriptionToPlainText(book.description);
    const cachedDescription = suppliedDescription || descriptionCache[key];

    if (cachedDescription) {
      setOverlay({
        bookKey: key,
        loading: false,
        pinned,
        text: cachedDescription,
        x,
        y,
      });
      return;
    }

    setOverlay({
      bookKey: key,
      loading: true,
      pinned,
      text: "Loading description…",
      x,
      y,
    });

    try {
      const term = encodeURIComponent(`${book.title} ${book.author}`);
      const response = await fetch(
        `https://itunes.apple.com/search?term=${term}&media=audiobook&limit=1`,
      );
      if (!response.ok) throw new Error("Description request failed");

      const data = (await response.json()) as {
        results?: Array<{ description?: string }>;
      };
      const description =
        descriptionToPlainText(data.results?.[0]?.description ?? "") ||
        NO_DESCRIPTION;

      setDescriptionCache((current) => ({ ...current, [key]: description }));
      setOverlay((current) =>
        current?.bookKey === key
          ? { ...current, loading: false, text: description }
          : current,
      );
    } catch {
      const description = "Failed to load description.";
      setDescriptionCache((current) => ({ ...current, [key]: description }));
      setOverlay((current) =>
        current?.bookKey === key
          ? { ...current, loading: false, text: description }
          : current,
      );
    }
  };

  const closeTransientOverlay = () => {
    setOverlay((current) => (current?.pinned ? current : null));
  };

  const tabs: Array<{ id: TabId; label: string; count: number }> = [
    { id: ALL_TAB_ID, label: "All charts", count: aggregated.length },
    ...BESTSELLER_SOURCES.map(({ id, label }) => ({
      id: id as TabId,
      label,
      count: lists[id]?.length ?? 0,
    })),
  ];

  const moveTabFocus = (event: React.KeyboardEvent, currentIndex: number) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
    else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    const nextTab = tabs[nextIndex].id;
    setActiveTab(nextTab);
    tabRefs.current[nextTab]?.focus();
  };

  const renderCard = (
    book: BestsellerBook,
    index: number,
    appearances?: AggregatedBestseller["appearances"],
  ) => {
    const key = bookKey(book);
    const descriptionIsOpen = overlay?.bookKey === key;
    const pinnedDescriptionIsOpen = descriptionIsOpen && overlay.pinned;

    return (
      <li className="bestseller-card" key={key}>
        <span className="bestseller-card__rank" aria-hidden="true">
          #{index + 1}
        </span>

        <button
          type="button"
          className="bestseller-card__search"
          aria-label={`Search for ${book.title} by ${book.author}`}
          aria-describedby={
            descriptionIsOpen ? DESCRIPTION_OVERLAY_ID : undefined
          }
          onClick={() => handleSearch(book)}
          onFocus={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            void showDescription(
              book,
              bounds.left + bounds.width / 2,
              bounds.bottom,
              false,
            );
          }}
          onBlur={closeTransientOverlay}
          onMouseEnter={(event) => {
            void showDescription(
              book,
              event.clientX,
              event.clientY,
              false,
            );
          }}
          onMouseMove={(event) => {
            setOverlay((current) =>
              current?.bookKey === key && !current.pinned
                ? { ...current, x: event.clientX, y: event.clientY }
                : current,
            );
          }}
          onMouseLeave={closeTransientOverlay}
        >
          {book.coverUrl ? (
            <img
              className="bestseller-card__cover"
              src={book.coverUrl}
              alt=""
              loading="lazy"
            />
          ) : (
            <span
              className="bestseller-card__cover bestseller-card__cover--placeholder"
              aria-hidden="true"
            >
              {index + 1}
            </span>
          )}

          <span className="bestseller-card__details">
            <span className="bestseller-card__title" title={book.title}>
              {book.title}
            </span>
            <span className="bestseller-card__author" title={book.author}>
              {book.author}
            </span>
            {appearances && (
              <span className="bestseller-card__badges">
                {appearances.map(({ source, rank }) => {
                  const sourceMeta = BESTSELLER_SOURCES.find(
                    (candidate) => candidate.id === source,
                  );
                  return (
                    <span
                      className={`bestseller-card__badge bestseller-card__badge--${source}`}
                      key={source}
                      title={`#${rank} on ${sourceMeta?.label ?? source}`}
                    >
                      {sourceMeta?.shortLabel ?? source} #{rank}
                    </span>
                  );
                })}
              </span>
            )}
          </span>
        </button>

        <button
          type="button"
          className="bestseller-card__info"
          aria-label={`Show description for ${book.title}`}
          aria-controls={DESCRIPTION_OVERLAY_ID}
          aria-expanded={pinnedDescriptionIsOpen}
          onClick={(event) => {
            if (pinnedDescriptionIsOpen) {
              setOverlay(null);
              return;
            }

            const bounds = event.currentTarget.getBoundingClientRect();
            void showDescription(
              book,
              bounds.left + bounds.width / 2,
              bounds.bottom,
              true,
            );
          }}
        >
          <Info aria-hidden="true" />
        </button>
      </li>
    );
  };

  if (loading) {
    return (
      <div className="bestseller-lists__status" role="status">
        Loading bestsellers…
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="bestseller-lists__status bestseller-lists__status--error"
        role="alert"
      >
        Error loading bestsellers: {error}
      </div>
    );
  }

  const activeBooks: Array<{
    book: BestsellerBook;
    appearances?: AggregatedBestseller["appearances"];
  }> =
    activeTab === ALL_TAB_ID
      ? aggregated.map(({ book, appearances }) => ({ book, appearances }))
      : (lists[activeTab] ?? []).map((book) => ({ book }));

  const overlayStyle = overlay
    ? ({
        "--bestseller-overlay-left": `${Math.min(
          overlay.x + 14,
          window.innerWidth - 334,
        )}px`,
        "--bestseller-overlay-top": `${Math.min(
          overlay.y + 14,
          window.innerHeight - 416,
        )}px`,
      } as React.CSSProperties)
    : undefined;

  return (
    <section className="bestseller-lists" aria-labelledby="bestseller-heading">
      <h2 id="bestseller-heading">Top Bestsellers</h2>

      <div
        className="bestseller-lists__tabs"
        role="tablist"
        aria-label="Bestseller chart sources"
      >
        {tabs.map((tab, index) => (
          <button
            type="button"
            role="tab"
            key={tab.id}
            id={`bestseller-tab-${tab.id}`}
            className="bestseller-lists__tab"
            aria-selected={activeTab === tab.id}
            aria-controls="bestseller-tabpanel"
            tabIndex={activeTab === tab.id ? 0 : -1}
            ref={(element) => {
              tabRefs.current[tab.id] = element;
            }}
            onClick={() => setActiveTab(tab.id)}
            onKeyDown={(event) => moveTabFocus(event, index)}
          >
            {tab.label}
            <span className="bestseller-lists__tab-count" aria-hidden="true">
              {tab.count}
            </span>
          </button>
        ))}
      </div>

      <div
        id="bestseller-tabpanel"
        role="tabpanel"
        aria-labelledby={`bestseller-tab-${activeTab}`}
      >
        {activeBooks.length === 0 ? (
          <p className="bestseller-list__empty">
            {activeTab === "nyt-fiction" || activeTab === "nyt-nonfiction"
              ? "No titles available. NYT charts need a Books API key in Settings → Discovery."
              : "No titles are currently available from this source."}
          </p>
        ) : (
          <ol className="bestseller-list__items">
            {activeBooks.map(({ book, appearances }, index) =>
              renderCard(book, index, appearances),
            )}
          </ol>
        )}
      </div>

      {overlay && (
        <div
          id={DESCRIPTION_OVERLAY_ID}
          className={`bestseller-description${
            overlay.pinned ? " bestseller-description--pinned" : ""
          }`}
          role={overlay.pinned ? "dialog" : "tooltip"}
          aria-label={overlay.pinned ? "Book description" : undefined}
          aria-live={overlay.loading ? "polite" : undefined}
          style={overlayStyle}
        >
          {overlay.pinned && (
            <button
              type="button"
              className="bestseller-description__close"
              aria-label="Close description"
              onClick={() => setOverlay(null)}
            >
              <X aria-hidden="true" />
            </button>
          )}
          <p>{overlay.text}</p>
        </div>
      )}
    </section>
  );
};
