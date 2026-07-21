import React, { useEffect, useState } from "react";
import { Info, X } from "lucide-react";

import "./BestsellerLists.css";

export interface BestsellerBook {
  title: string;
  author: string;
  coverUrl: string;
  description: string;
  source: "audible" | "audiobooksnow";
}

interface BestsellersResponse {
  results?: {
    audible?: BestsellerBook[];
    audiobooksnow?: BestsellerBook[];
  };
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

export const BestsellerLists: React.FC = () => {
  const [audible, setAudible] = useState<BestsellerBook[]>([]);
  const [abn, setAbn] = useState<BestsellerBook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [descriptionCache, setDescriptionCache] = useState<
    Record<string, string>
  >({});
  const [overlay, setOverlay] = useState<DescriptionOverlay | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    const fetchBestsellers = async () => {
      try {
        const response = await fetch("/api/librarian/bestsellers", {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Failed to fetch bestsellers");

        const data = (await response.json()) as BestsellersResponse;
        setAudible(
          Array.isArray(data.results?.audible) ? data.results.audible : [],
        );
        setAbn(
          Array.isArray(data.results?.audiobooksnow)
            ? data.results.audiobooksnow
            : [],
        );
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

  const renderList = (
    books: BestsellerBook[],
    title: string,
    listId: string,
  ) => (
    <section className="bestseller-list" aria-labelledby={`${listId}-heading`}>
      <h3 id={`${listId}-heading`}>{title}</h3>

      {books.length === 0 ? (
        <p className="bestseller-list__empty">
          No titles are currently available from this source.
        </p>
      ) : (
        <ol className="bestseller-list__items">
          {books.map((book, index) => {
            const key = bookKey(book);
            const descriptionIsOpen = overlay?.bookKey === key;
            const pinnedDescriptionIsOpen =
              descriptionIsOpen && overlay.pinned;

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
          })}
        </ol>
      )}
    </section>
  );

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

      <div className="bestseller-lists__grid">
        {renderList(audible, "Audible Bestsellers", "audible-bestsellers")}
        {renderList(abn, "AudiobooksNow Bestsellers", "abn-bestsellers")}
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
