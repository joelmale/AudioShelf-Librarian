import React, { useState } from "react";
import { useToast } from "../../curator/toast";

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

export const AudiobookSearch: React.FC = () => {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloadingUrl, setDownloadingUrl] = useState<string | null>(null);
  const [sentUrls, setSentUrls] = useState<Set<string>>(new Set());

  const toast = useToast();

  const executeSearch = async (searchQuery: string, page: number = 1) => {
    if (!searchQuery) return;
    setIsSearching(true);
    setError(null);
    try {
      const res = await fetch(`/api/librarian/search?q=${encodeURIComponent(searchQuery)}&cat=${category}&page=${page}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Search failed");
      setResults(data.results || []);
      setTotalPages(data.totalPages || 1);
      setCurrentPage(data.currentPage || 1);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsSearching(false);
    }
  };

  React.useEffect(() => {
    const handleTriggerSearch = (e: Event) => {
      const customEvent = e as CustomEvent<{ query: string }>;
      if (customEvent.detail && customEvent.detail.query) {
        setQuery(customEvent.detail.query);
        executeSearch(customEvent.detail.query, 1);
        
        // Scroll to the search component
        const searchEl = document.getElementById("audiobook-search-section");
        if (searchEl) {
          searchEl.scrollIntoView({ behavior: "smooth" });
        }
      }
    };
    window.addEventListener('trigger-audiobook-search', handleTriggerSearch);
    return () => window.removeEventListener('trigger-audiobook-search', handleTriggerSearch);
  }, []);

  const handleSearch = async (e?: React.FormEvent, page: number = 1) => {
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
        body: JSON.stringify({ bookUrl })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to trigger download");
      
      setSentUrls(prev => {
        const newSet = new Set(prev);
        newSet.add(bookUrl);
        return newSet;
      });
      toast("Successfully sent to qBittorrent!", "success");
      setDownloadingUrl(null);
    } catch (err: any) {
      toast(err.message, "error");
      setDownloadingUrl(null);
    }
  };

  return (
    <div id="audiobook-search-section" className="glass-panel" style={{ marginTop: '24px' }}>
      <h3 style={{ marginTop: 0, marginBottom: '20px' }}>Search AudiobookBay</h3>
      
      <form onSubmit={handleSearch} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '16px', marginBottom: '24px' }}>
        <input 
          type="text" 
          className="glass-input" 
          placeholder="Search title, author..." 
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        
        <select 
          className="glass-input" 
          style={{ width: 'auto', minWidth: '150px' }}
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
        
        <div style={{ display: 'flex', gap: '8px' }}>
          <button type="submit" className="glass-button" disabled={isSearching || !query}>
            {isSearching ? "Searching..." : "Search"}
          </button>
          <button 
            type="button" 
            className="glass-button" 
            style={{ background: 'rgba(0,0,0,0.05)', color: 'var(--text-primary)', boxShadow: 'none' }}
            onClick={() => {
              setQuery("");
              setCategory("");
              setResults([]);
              setCurrentPage(1);
              setTotalPages(1);
            }}
          >
            Clear
          </button>
        </div>
      </form>

      {error && (
        <div style={{ color: 'var(--secondary-accent)', marginBottom: '16px', fontSize: '0.9rem' }}>
          {error}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '20px' }}>
        {results.map((r) => (
          <div key={r.url} style={{
            background: 'rgba(255,255,255,0.6)',
            borderRadius: '12px',
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            border: '1px solid var(--glass-border)'
          }}>
            {r.coverUrl && (
              <a href={r.url} target="_blank" rel="noopener noreferrer">
                <img 
                  src={r.coverUrl} 
                  alt="Cover" 
                  style={{ width: '100%', height: '200px', objectFit: 'cover', borderRadius: '8px', cursor: 'pointer' }}
                />
              </a>
            )}
            <div style={{ flexGrow: 1 }}>
              <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: '8px', lineHeight: 1.4 }}>{r.title}</div>
              
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '12px' }}>
                {r.size && r.size !== "Unknown" && (
                  <span style={{ background: 'var(--primary-accent)', color: 'white', padding: '2px 8px', borderRadius: '12px', fontSize: '0.75rem', fontWeight: 500 }}>
                    {r.size}
                  </span>
                )}
                {r.category && r.category !== "Audiobook" && (
                  <span style={{ background: 'rgba(0,0,0,0.1)', padding: '2px 8px', borderRadius: '12px', fontSize: '0.75rem', fontWeight: 500 }}>
                    {r.category}
                  </span>
                )}
                {r.added && r.added !== "Unknown" && (
                  <span style={{ background: 'rgba(0,0,0,0.1)', padding: '2px 8px', borderRadius: '12px', fontSize: '0.75rem', fontWeight: 500 }}>
                    {r.added}
                  </span>
                )}
              </div>
            </div>
            
            <button 
              className="glass-button" 
              style={{ padding: '8px', fontSize: '0.85rem' }}
              disabled={downloadingUrl === r.url || sentUrls.has(r.url)}
              onClick={() => handleDownload(r.url)}
            >
              {downloadingUrl === r.url 
                ? "Sending..." 
                : sentUrls.has(r.url)
                  ? "Download sent"
                  : "Download via qBittorrent"
              }
            </button>
          </div>
        ))}
        {results.length === 0 && !isSearching && query && !error && (
          <div style={{ color: 'var(--text-secondary)' }}>No results found.</div>
        )}
      </div>

      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '16px', marginTop: '24px' }}>
          <button 
            className="glass-button" 
            disabled={currentPage <= 1 || isSearching}
            onClick={() => handleSearch(undefined, currentPage - 1)}
          >
            Previous
          </button>
          <span style={{ fontSize: '0.9rem', fontWeight: 500 }}>
            Page {currentPage} of {totalPages}
          </span>
          <button 
            className="glass-button" 
            disabled={currentPage >= totalPages || isSearching}
            onClick={() => handleSearch(undefined, currentPage + 1)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
};
