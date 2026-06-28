import React, { useState } from "react";
import type { ABBSearchResult } from "@audioshelf/backend/src/modules/librarian/services/audiobookbay.js"; // Type-only import or redefine
// Actually, I will redefine it locally since importing from backend src directly in vite might be tricky if not in shared.

interface SearchResult {
  id: string;
  title: string;
  coverUrl: string;
  category: string;
  size: string;
  seeders: number;
  url: string;
}

export const AudiobookSearch: React.FC = () => {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloadingUrl, setDownloadingUrl] = useState<string | null>(null);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query) return;

    setIsSearching(true);
    setError(null);

    try {
      const res = await fetch(`/api/librarian/search?q=${encodeURIComponent(query)}&cat=${category}`);
      const data = await res.json();
      
      if (!res.ok) throw new Error(data.error || "Search failed");
      
      setResults(data.results || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsSearching(false);
    }
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
      
      alert("Successfully sent to qBittorrent!");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setDownloadingUrl(null);
    }
  };

  return (
    <div className="glass-panel" style={{ marginTop: '24px' }}>
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
        
        <button type="submit" className="glass-button" disabled={isSearching || !query}>
          {isSearching ? "Resolving Proxies..." : "Search"}
        </button>
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
            </div>
            
            <button 
              className="glass-button" 
              style={{ padding: '8px', fontSize: '0.85rem' }}
              disabled={downloadingUrl === r.url}
              onClick={() => handleDownload(r.url)}
            >
              {downloadingUrl === r.url ? "Sending..." : "Download via qBittorrent"}
            </button>
          </div>
        ))}
        {results.length === 0 && !isSearching && query && !error && (
          <div style={{ color: 'var(--text-secondary)' }}>No results found.</div>
        )}
      </div>
    </div>
  );
};
