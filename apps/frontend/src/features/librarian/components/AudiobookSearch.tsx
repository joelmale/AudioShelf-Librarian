import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, LoaderCircle } from "lucide-react";
import { Link, useLocation } from "react-router-dom";

import { useToast } from "../../curator/toast.js";
import { sanitizeReturnTo } from "../utils/safeNavigation.js";
import { AntiBotChallengeModal } from "./AntiBotChallengeModal.js";

interface SearchResult {
  id: string;
  title: string;
  coverUrl: string;
  category: string;
  size: string;
  seeders: number;
  added: string;
  url: string;
}

type SearchStatus = "idle" | "searching" | "empty" | "error" | "results";

export const AudiobookSearch: React.FC = () => {
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);
  const initialQuery = searchParams.get("q") || "";
  const rawReturnTo = searchParams.get("returnTo") || (location.state as { returnTo?: string } | null)?.returnTo;
  const safeReturnTo = sanitizeReturnTo(rawReturnTo, "");

  const [query, setQuery] = useState(initialQuery);
  const [submittedQuery, setSubmittedQuery] = useState(initialQuery);
  const [category, setCategory] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [status, setStatus] = useState<SearchStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [downloadingUrl, setDownloadingUrl] = useState<string | null>(null);
  const [sentUrls, setSentUrls] = useState<Set<string>>(new Set());
  const [challengeUrl, setChallengeUrl] = useState<string | null>(null);

  const requestIdRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const autoSearchStarted = useRef(false);

  const toast = useToast();

  const executeSearch = useCallback(async (searchQuery: string, page = 1) => {
    const trimmed = searchQuery.trim();
    if (!trimmed) {
      setStatus("idle");
      setResults([]);
      return;
    }

    // Cancel in-flight search request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const thisRequestId = ++requestIdRef.current;

    setStatus("searching");
    setError(null);
    setSubmittedQuery(trimmed);

    try {
      const res = await fetch(
        `/api/librarian/search?q=${encodeURIComponent(trimmed)}&cat=${category}&page=${page}`,
        { signal: controller.signal },
      );
      const data = (await res.json()) as {
        results?: SearchResult[];
        totalPages?: number;
        currentPage?: number;
        requiresChallenge?: boolean;
        challengeUrl?: string;
        error?: string;
      };

      // Stale response guard: ignore if a newer search was initiated
      if (thisRequestId !== requestIdRef.current) {
        return;
      }

      if (!res.ok) {
        if (res.status === 403 && data.requiresChallenge && data.challengeUrl) {
          setChallengeUrl(data.challengeUrl);
          throw new Error("Anti-bot challenge required");
        }
        throw new Error(data.error || "Search failed");
      }

      const returnedResults = data.results || [];
      setResults(returnedResults);
      setTotalPages(data.totalPages || 1);
      setCurrentPage(data.currentPage || 1);
      setStatus(returnedResults.length === 0 ? "empty" : "results");
    } catch (err: unknown) {
      if (thisRequestId !== requestIdRef.current) {
        return;
      }
      if (err instanceof Error && err.name === "AbortError") {
        return;
      }
      const message = err instanceof Error ? err.message : "Search failed";
      if (message !== "Anti-bot challenge required") {
        setError(message);
        setStatus("error");
      }
    }
  }, [category]);

  // Support trigger-audiobook-search custom events for backwards compatibility
  useEffect(() => {
    const handleTriggerSearch = (e: Event) => {
      const customEvent = e as CustomEvent<{ query?: string }>;
      if (customEvent.detail?.query) {
        setQuery(customEvent.detail.query);
        void executeSearch(customEvent.detail.query, 1);

        const searchEl = document.getElementById("audiobook-search-section");
        if (searchEl) {
          searchEl.scrollIntoView({ behavior: "smooth" });
        }
      }
    };
    window.addEventListener("trigger-audiobook-search", handleTriggerSearch);
    return () => window.removeEventListener("trigger-audiobook-search", handleTriggerSearch);
  }, [executeSearch]);

  // Auto-search on direct entry with ?q=
  useEffect(() => {
    if (!initialQuery || autoSearchStarted.current) return;
    autoSearchStarted.current = true;
    void executeSearch(initialQuery, 1);
  }, [initialQuery, executeSearch]);

  const handleSearch = async (e?: React.FormEvent, page = 1) => {
    if (e) e.preventDefault();
    await executeSearch(query, page);
  };

  const handleDownload = async (bookUrl: string) => {
    setDownloadingUrl(bookUrl);
    setError(null);

    try {
      const res = await fetch("/api/librarian/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookUrl }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error || "Failed to trigger download");

      setSentUrls((prev) => {
        const newSet = new Set(prev);
        newSet.add(bookUrl);
        return newSet;
      });
      toast("Successfully sent to qBittorrent!", "success");
      setDownloadingUrl(null);
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : "Failed to trigger download", "error");
      setDownloadingUrl(null);
    }
  };

  const isSearching = status === "searching";

  return (
    <div id="audiobook-search-section" className="glass-panel" style={{ marginTop: "24px" }}>
      {safeReturnTo && (
        <div style={{ marginBottom: "16px" }}>
          <Link
            to={safeReturnTo}
            className="glass-button"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              fontSize: "0.85rem",
              padding: "6px 12px",
            }}
          >
            <ArrowLeft size={14} /> Back to chart
          </Link>
        </div>
      )}

      <h3 style={{ marginTop: 0, marginBottom: "20px" }}>Search AudiobookBay</h3>

      <form
        onSubmit={(e) => void handleSearch(e)}
        style={{
          display: "grid",
          gridTemplateColumns: "1fr auto auto",
          gap: "16px",
          marginBottom: "24px",
        }}
      >
        <input
          type="text"
          className="glass-input"
          placeholder="Search title, author..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <select
          className="glass-input"
          style={{ width: "auto", minWidth: "150px" }}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">All Categories</option>
          <option value="1">Sci-Fi</option>
          <option value="2">Fantasy</option>
          <option value="3">Non-Fiction</option>
          <option value="4">Mystery</option>
          <option value="5">Romance</option>
        </select>

        <div style={{ display: "flex", gap: "8px" }}>
          <button type="submit" className="glass-button" disabled={isSearching || !query.trim()}>
            {isSearching ? (
              <>
                <LoaderCircle className="spin" size={14} style={{ marginRight: 6 }} /> Searching...
              </>
            ) : (
              "Search"
            )}
          </button>
          <button
            type="button"
            className="glass-button"
            style={{
              background: "rgba(0,0,0,0.05)",
              color: "var(--text-primary)",
              boxShadow: "none",
            }}
            onClick={() => {
              if (abortControllerRef.current) {
                abortControllerRef.current.abort();
              }
              setQuery("");
              setSubmittedQuery("");
              setCategory("");
              setResults([]);
              setStatus("idle");
              setCurrentPage(1);
              setTotalPages(1);
            }}
          >
            Clear
          </button>
        </div>
      </form>

      {error && (
        <div
          role="alert"
          style={{
            color: "var(--secondary-accent, #b4233b)",
            marginBottom: "16px",
            fontSize: "0.9rem",
          }}
        >
          {error}
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
          gap: "20px",
        }}
      >
        {results.map((r) => (
          <div
            key={r.url}
            style={{
              background: "rgba(255,255,255,0.6)",
              borderRadius: "12px",
              padding: "16px",
              display: "flex",
              flexDirection: "column",
              gap: "12px",
              border: "1px solid var(--glass-border)",
            }}
          >
            {r.coverUrl && (
              <a href={r.url} target="_blank" rel="noopener noreferrer">
                <img
                  src={r.coverUrl}
                  alt="Cover"
                  style={{
                    width: "100%",
                    height: "200px",
                    objectFit: "cover",
                    borderRadius: "8px",
                    cursor: "pointer",
                  }}
                />
              </a>
            )}
            <div style={{ flexGrow: 1 }}>
              <div
                style={{
                  fontWeight: 600,
                  fontSize: "0.9rem",
                  marginBottom: "8px",
                  lineHeight: 1.4,
                }}
              >
                {r.title}
              </div>

              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "6px",
                  marginBottom: "12px",
                }}
              >
                {r.size && r.size !== "Unknown" && (
                  <span
                    style={{
                      background: "var(--primary-accent)",
                      color: "white",
                      padding: "2px 8px",
                      borderRadius: "12px",
                      fontSize: "0.75rem",
                      fontWeight: 500,
                    }}
                  >
                    {r.size}
                  </span>
                )}
                {r.category && r.category !== "Audiobook" && (
                  <span
                    style={{
                      background: "rgba(0,0,0,0.1)",
                      padding: "2px 8px",
                      borderRadius: "12px",
                      fontSize: "0.75rem",
                      fontWeight: 500,
                    }}
                  >
                    {r.category}
                  </span>
                )}
                {r.added && r.added !== "Unknown" && (
                  <span
                    style={{
                      background: "rgba(0,0,0,0.1)",
                      padding: "2px 8px",
                      borderRadius: "12px",
                      fontSize: "0.75rem",
                      fontWeight: 500,
                    }}
                  >
                    {r.added}
                  </span>
                )}
              </div>
            </div>

            <button
              className="glass-button"
              style={{ padding: "8px", fontSize: "0.85rem" }}
              disabled={downloadingUrl === r.url || sentUrls.has(r.url)}
              onClick={() => void handleDownload(r.url)}
            >
              {downloadingUrl === r.url
                ? "Sending..."
                : sentUrls.has(r.url)
                  ? "Download sent"
                  : "Download via qBittorrent"}
            </button>
          </div>
        ))}

        {status === "empty" && (
          <div style={{ color: "var(--text-secondary)" }}>
            No results found for &ldquo;{submittedQuery}&rdquo;.
          </div>
        )}
      </div>

      {totalPages > 1 && (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            gap: "16px",
            marginTop: "24px",
          }}
        >
          <button
            className="glass-button"
            disabled={currentPage <= 1 || isSearching}
            onClick={() => void handleSearch(undefined, currentPage - 1)}
          >
            Previous
          </button>
          <span style={{ fontSize: "0.9rem", fontWeight: 500 }}>
            Page {currentPage} of {totalPages}
          </span>
          <button
            className="glass-button"
            disabled={currentPage >= totalPages || isSearching}
            onClick={() => void handleSearch(undefined, currentPage + 1)}
          >
            Next
          </button>
        </div>
      )}

      {challengeUrl && (
        <AntiBotChallengeModal
          challengeUrl={challengeUrl}
          onClose={(success) => {
            setChallengeUrl(null);
            if (success) {
              void handleSearch(undefined, currentPage);
            }
          }}
        />
      )}
    </div>
  );
};
