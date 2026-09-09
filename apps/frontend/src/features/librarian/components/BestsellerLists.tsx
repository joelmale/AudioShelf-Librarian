import React, { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, Clock, Info, Key, RotateCw, Undo2, X } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";

import { browseContext } from "../context/browseContext.js";
import {
  useCandidateIntents,
  useSetCandidateIntent,
  useUndoCandidateIntent,
  type CandidateIntentType,
  type SourceSnapshotInfo,
} from "../../curator/api.js";
import "./BestsellerLists.css";

export type BestsellerSource =
  | "audible"
  | "audiobooksnow"
  | "apple"
  | "nyt-fiction"
  | "nyt-nonfiction";

export interface BestsellerBook {
  id?: string;
  title: string;
  author: string;
  coverUrl: string;
  description: string;
  source: BestsellerSource;
  sourceItemId?: string;
  sourceUrl?: string;
  ownership?: 'owned' | 'unowned' | 'possible';
  isFinished?: boolean;
}

interface BestsellersResponse {
  results?: {
    audible?: BestsellerBook[];
    audiobooksnow?: BestsellerBook[];
    apple?: BestsellerBook[];
    nytFiction?: BestsellerBook[];
    nytNonfiction?: BestsellerBook[];
  };
  sources?: Record<string, SourceSnapshotInfo>;
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

export const ALL_TAB_ID = "all" as const;
export type TabId = typeof ALL_TAB_ID | BestsellerSource;

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
  error?: boolean;
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

function getInitialTab(): TabId {
  if (typeof window !== "undefined") {
    const urlParam = new URLSearchParams(window.location.search).get("tab") as TabId | null;
    if (urlParam && (urlParam === ALL_TAB_ID || BESTSELLER_SOURCES.some((s) => s.id === urlParam))) {
      return urlParam;
    }
  }
  const snapshot = browseContext.getBestsellersSnapshot();
  if (snapshot?.activeTab && (snapshot.activeTab === ALL_TAB_ID || BESTSELLER_SOURCES.some((s) => s.id === snapshot.activeTab))) {
    return snapshot.activeTab as TabId;
  }
  return ALL_TAB_ID;
}

export interface BestsellerListsProps {
  onSearch?: (book: BestsellerBook, query: string, returnTo: string) => void;
}

export const BestsellerLists: React.FC<BestsellerListsProps> = ({ onSearch }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const searchTab = useMemo(() => {
    const param = new URLSearchParams(location.search).get("tab") as TabId | null;
    if (param && (param === ALL_TAB_ID || BESTSELLER_SOURCES.some((s) => s.id === param))) {
      return param;
    }
    return null;
  }, [location.search]);

  const initialSnapshot = useRef(browseContext.getBestsellersSnapshot());
  const [lists, setLists] = useState<Partial<Record<BestsellerSource, BestsellerBook[]>>>(
    () => initialSnapshot.current?.lists ?? {},
  );
  const [sources, setSources] = useState<BestsellersResponse['sources']>();
  const [activeTab, setActiveTab] = useState<TabId>(() => searchTab || getInitialTab());

  useEffect(() => {
    if (searchTab && searchTab !== activeTab) {
      setActiveTab(searchTab);
    }
  }, [searchTab]);

  const [loading, setLoading] = useState<boolean>(() => {
    const hasCached = initialSnapshot.current?.lists && Object.keys(initialSnapshot.current.lists).length > 0;
    return !hasCached;
  });
  const [error, setError] = useState<string | null>(null);
  const [descriptionCache, setDescriptionCache] = useState<Record<string, string>>({});
  const [overlay, setOverlay] = useState<DescriptionOverlay | null>(null);
  const [failedCovers, setFailedCovers] = useState<Set<string>>(new Set());
  const tabRefs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({});
  const triggerRef = useRef<HTMLElement | null>(null);
  const candidateIds = useMemo(() => {
    const ids: string[] = [];
    for (const list of Object.values(lists)) {
      if (list) {
        for (const book of list) {
          const id = book.id || consensusKey(book);
          if (id) ids.push(id);
        }
      }
    }
    return ids;
  }, [lists]);

  const { data: intentsData, refetch: refetchIntents } = useCandidateIntents(candidateIds);
  const setIntentMutation = useSetCandidateIntent();
  const undoIntentMutation = useUndoCandidateIntent();

  const handleTriage = (event: React.MouseEvent, book: BestsellerBook, intent: CandidateIntentType) => {
    event.stopPropagation();
    event.preventDefault();
    const candidateId = book.id || consensusKey(book);
    const active = intentsData?.intents?.[candidateId];
    setIntentMutation.mutate(
      {
        candidateId,
        intent,
        expectedRevision: active?.revision,
        candidate: {
          id: candidateId,
          source: book.source,
          sourceItemId: book.sourceItemId,
          sourceUrl: book.sourceUrl,
          title: book.title,
          author: book.author,
          coverUrl: book.coverUrl,
          description: book.description,
        },
      },
      {
        onError: (err: unknown) => {
          if (err instanceof Error && err.message.includes('conflict')) {
            void refetchIntents();
          }
        },
      }
    );
  };

  const handleUndo = (event: React.MouseEvent, book: BestsellerBook) => {
    event.stopPropagation();
    event.preventDefault();
    const candidateId = book.id || consensusKey(book);
    undoIntentMutation.mutate({ candidateId });
  };

  useEffect(() => {
    const controller = new AbortController();

    const fetchBestsellers = async () => {
      try {
        const response = await fetch("/api/librarian/bestsellers", {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Failed to fetch bestsellers");

        const data = (await response.json()) as BestsellersResponse;
        if (data.sources) setSources(data.sources);
        const next: Partial<Record<BestsellerSource, BestsellerBook[]>> = {};
        for (const { id, responseKey } of BESTSELLER_SOURCES) {
          const books = data.results?.[responseKey];
          next[id] = Array.isArray(books) ? books : [];
        }
        setLists(next);
        setError(null);
        browseContext.setBestsellersSnapshot({
          lists: next,
          activeTab,
          selectedAnchor: window.location.hash.replace(/^#/, ""),
          timestamp: Date.now(),
        });
      } catch (fetchError: unknown) {
        if (fetchError instanceof Error && fetchError.name === "AbortError") {
          return;
        }
        // Only surface error if we have no cached lists
        const hasCached =
          initialSnapshot.current?.lists &&
          Object.keys(initialSnapshot.current.lists).length > 0;
        if (!hasCached) {
          setError(
            fetchError instanceof Error
              ? fetchError.message
              : "Failed to load bestsellers",
          );
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    void fetchBestsellers();
    return () => controller.abort();
  }, []);

  // Handle Escape to close pinned overlay and restore focus
  useEffect(() => {
    const closePinnedOverlay = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOverlay((current) => {
          if (current?.pinned) {
            triggerRef.current?.focus();
            return null;
          }
          return current;
        });
      }
    };

    window.addEventListener("keydown", closePinnedOverlay);
    return () => window.removeEventListener("keydown", closePinnedOverlay);
  }, []);

  // Anchor and scroll restoration
  useEffect(() => {
    if (loading) return;
    const hash = window.location.hash.replace(/^#/, "");
    const targetAnchor = hash || browseContext.getBestsellersSnapshot()?.selectedAnchor;
    if (targetAnchor) {
      const element = document.getElementById(targetAnchor);
      if (element) {
        element.scrollIntoView?.({ behavior: "auto", block: "nearest" });
        const button = element.querySelector<HTMLButtonElement>(".bestseller-card__search");
        button?.focus();
      }
    }
  }, [loading, activeTab]);

  const aggregated = useMemo(() => aggregateBestsellers(lists), [lists]);

  const handleTabChange = (tabId: TabId) => {
    setActiveTab(tabId);
    browseContext.setBestsellersSnapshot({
      lists,
      activeTab: tabId,
      selectedAnchor: window.location.hash.replace(/^#/, ""),
      timestamp: Date.now(),
    });
  };

  const handleSearch = (book: BestsellerBook, candidateIndex: number) => {
    const query = buildBestsellerSearchQuery(book);
    const anchor = `bestseller-item-${candidateIndex}`;
    const returnUrl = `/discover/charts?tab=${activeTab}#${anchor}`;

    browseContext.setBestsellersSnapshot({
      lists,
      activeTab,
      selectedAnchor: anchor,
      timestamp: Date.now(),
    });

    window.dispatchEvent(
      new CustomEvent("trigger-audiobook-search", {
        detail: { query, returnTo: returnUrl },
      }),
    );

    if (onSearch) {
      onSearch(book, query, returnUrl);
    } else {
      navigate(
        `/discover/search?q=${encodeURIComponent(query)}&returnTo=${encodeURIComponent(returnUrl)}`,
      );
    }
  };

  const showDescription = async (
    book: BestsellerBook,
    x: number,
    y: number,
    pinned: boolean,
    forceRetry = false,
  ) => {
    if (!pinned && overlay?.pinned) return;

    const key = bookKey(book);
    const suppliedDescription = descriptionToPlainText(book.description);
    const cachedDescription = suppliedDescription || descriptionCache[key];

    if (cachedDescription && !forceRetry) {
      setOverlay({
        bookKey: key,
        loading: false,
        pinned,
        text: cachedDescription,
        x,
        y,
        error: false,
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
      error: false,
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
          ? { ...current, loading: false, text: description, error: false }
          : current,
      );
    } catch {
      const description = "Failed to load description.";
      // Do not cache failure in descriptionCache so it can be retried
      setOverlay((current) =>
        current?.bookKey === key
          ? { ...current, loading: false, text: description, error: true }
          : current,
      );
    }
  };

  const closeOverlay = (restoreFocus = true) => {
    setOverlay(null);
    if (restoreFocus && triggerRef.current) {
      triggerRef.current.focus();
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
    handleTabChange(nextTab);
    tabRefs.current[nextTab]?.focus();
  };

  const activeBooks: Array<{
    book: BestsellerBook;
    appearances?: AggregatedBestseller["appearances"];
  }> =
    activeTab === ALL_TAB_ID
      ? aggregated.map(({ book, appearances }) => ({ book, appearances }))
      : (lists[activeTab] ?? []).map((book) => ({ book }));

  const renderCard = (
    book: BestsellerBook,
    index: number,
    appearances?: AggregatedBestseller["appearances"],
  ) => {
    const key = bookKey(book);
    const candidateNumber = index + 1;
    const anchorId = `bestseller-item-${candidateNumber}`;
    const descriptionIsOpen = overlay?.bookKey === key;
    const pinnedDescriptionIsOpen = descriptionIsOpen && overlay.pinned;
    const hasCover = Boolean(book.coverUrl) && !failedCovers.has(key);

    const candidateId = book.id || consensusKey(book);
    const activeIntent = intentsData?.intents?.[candidateId];

    return (
      <li
        className={`bestseller-card ${activeIntent ? `bestseller-card--triage-${activeIntent.intent}` : ''}`}
        key={key}
        id={anchorId}
        data-candidate-index={candidateNumber}
      >
        <div className="bestseller-card__row">
          <span className="bestseller-card__rank" aria-hidden="true">
            #{candidateNumber}
          </span>

          <button
            type="button"
            className="bestseller-card__search"
            aria-label={`Search for ${book.title} by ${book.author}`}
            aria-describedby={
              descriptionIsOpen ? DESCRIPTION_OVERLAY_ID : undefined
            }
            onClick={() => handleSearch(book, candidateNumber)}
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
            {hasCover ? (
              <img
                className="bestseller-card__cover"
                src={book.coverUrl}
                alt=""
                loading="lazy"
                onError={() => {
                  setFailedCovers((prev) => new Set(prev).add(key));
                }}
              />
            ) : (
              <span
                className="bestseller-card__cover bestseller-card__cover--placeholder"
                aria-hidden="true"
              >
                #{candidateNumber}
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
                closeOverlay(true);
                return;
              }

              triggerRef.current = event.currentTarget;
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
        </div>

        <div className="bestseller-card__triage">
          <div className="bestseller-triage-group">
            <button
              type="button"
              className={`bestseller-triage-btn ${activeIntent?.intent === 'want' ? 'bestseller-triage-btn--active-want' : ''}`}
              title="Want to acquire"
              onClick={(e) => handleTriage(e, book, 'want')}
            >
              <Check size={12} />
              <span>Want</span>
            </button>
            <button
              type="button"
              className={`bestseller-triage-btn ${activeIntent?.intent === 'later' ? 'bestseller-triage-btn--active-later' : ''}`}
              title="Decide later"
              onClick={(e) => handleTriage(e, book, 'later')}
            >
              <Clock size={12} />
              <span>Later</span>
            </button>
            <button
              type="button"
              className={`bestseller-triage-btn ${activeIntent?.intent === 'pass' ? 'bestseller-triage-btn--active-pass' : ''}`}
              title="Pass on this title"
              onClick={(e) => handleTriage(e, book, 'pass')}
            >
              <X size={12} />
              <span>Pass</span>
            </button>
            {activeIntent && (
              <button
                type="button"
                className="bestseller-triage-undo"
                title="Undo triage choice"
                onClick={(e) => handleUndo(e, book)}
              >
                <Undo2 size={12} />
                <span>Undo</span>
              </button>
            )}
          </div>
          {book.isFinished ? (
            <span className="bestseller-card__ownership bestseller-card__ownership--finished" title="Finished in your library">
              Finished
            </span>
          ) : book.ownership === 'owned' ? (
            <span className="bestseller-card__ownership bestseller-card__ownership--owned" title="Already in your library">
              In Library
            </span>
          ) : null}
        </div>
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
            onClick={() => handleTabChange(tab.id)}
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
        {activeTab !== ALL_TAB_ID && (() => {
          const src = sources?.[activeTab];
          if (!src) return null;
          if (src.status === 'stale') {
            const timeStr = src.lastSuccessAt ? new Date(src.lastSuccessAt).toLocaleDateString() : 'earlier';
            return (
              <div className="bestseller-source-notice bestseller-source-notice--stale" role="status">
                <Info size={16} />
                <span>
                  Showing cached titles from {timeStr}. Live refresh failed: {src.errorMessage || 'Source temporary error'}
                </span>
              </div>
            );
          }
          if (src.status === 'failed') {
            return (
              <div className="bestseller-source-notice bestseller-source-notice--failed" role="alert">
                <AlertTriangle size={16} />
                <span>Source unavailable: {src.errorMessage || 'Unable to contact provider'}</span>
              </div>
            );
          }
          if (src.status === 'not-configured') {
            return (
              <div className="bestseller-source-notice bestseller-source-notice--warn" role="status">
                <Key size={16} />
                <span>API key not configured in Settings → Discovery.</span>
              </div>
            );
          }
          return null;
        })()}
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
              onClick={() => closeOverlay(true)}
            >
              <X aria-hidden="true" />
            </button>
          )}
          <p>{overlay.text}</p>
          {overlay.error && overlay.pinned && (
            <div className="bestseller-description__retry-container" style={{ marginTop: 8 }}>
              <button
                type="button"
                className="bestseller-description__retry"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 10px",
                  borderRadius: 6,
                  background: "rgba(255, 255, 255, 0.15)",
                  color: "#fff",
                  border: "1px solid rgba(255, 255, 255, 0.3)",
                  cursor: "pointer",
                  fontSize: "0.8rem",
                }}
                onClick={() => {
                  const target = activeBooks.find((b) => bookKey(b.book) === overlay.bookKey)?.book;
                  if (target) {
                    void showDescription(target, overlay.x, overlay.y, true, true);
                  }
                }}
              >
                <RotateCw size={12} /> Retry description
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
};
