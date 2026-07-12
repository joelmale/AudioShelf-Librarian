import React, { useState, useEffect } from "react";

interface BestsellerBook {
  title: string;
  author: string;
  coverUrl: string;
  description: string;
  source: "audible" | "audiobooksnow";
}

export const BestsellerLists: React.FC = () => {
  const [audible, setAudible] = useState<BestsellerBook[]>([]);
  const [abn, setAbn] = useState<BestsellerBook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Lazy loading state
  const [itunesCache, setItunesCache] = useState<Record<string, string>>({});
  const [tooltip, setTooltip] = useState<{ visible: boolean, x: number, y: number, text: string, html: boolean, loading: boolean } | null>(null);

  useEffect(() => {
    const fetchBestsellers = async () => {
      try {
        const res = await fetch("/api/librarian/bestsellers");
        if (!res.ok) throw new Error("Failed to fetch bestsellers");
        const data = await res.json();
        
        if (data.results) {
          setAudible(data.results.audible || []);
          setAbn(data.results.audiobooksnow || []);
        }
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    fetchBestsellers();
  }, []);

  const handleSearch = (book: BestsellerBook) => {
    // Search using the main title and the author for maximum accuracy.
    const mainTitle = book.title.split(':')[0].trim();
    const query = `${mainTitle} ${book.author}`;
    window.dispatchEvent(new CustomEvent('trigger-audiobook-search', { detail: { query } }));
  };

  if (loading) {
    return (
      <div style={{ padding: "24px", color: "var(--text-secondary)" }}>
        Loading bestsellers...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: "24px", color: "var(--secondary-accent)" }}>
        Error loading bestsellers: {error}
      </div>
    );
  }

  const renderList = (books: BestsellerBook[], title: string, sourceImg: string) => (
    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
      <h3 style={{ 
        display: "flex", 
        alignItems: "center", 
        gap: "12px",
        marginBottom: "16px",
        fontSize: "1.2rem",
        fontWeight: "600",
        background: "linear-gradient(90deg, var(--primary-accent), var(--text-primary))",
        WebkitBackgroundClip: "text",
        WebkitTextFillColor: "transparent"
      }}>
        {title}
      </h3>
      
      <div style={{
        display: "flex",
        flexDirection: "column",
        gap: "12px",
        maxHeight: "600px",
        overflowY: "auto",
        paddingRight: "8px"
      }} className="hide-scrollbar">
        {books.map((book, i) => (
          <div 
            key={i}
            onClick={() => handleSearch(book)}
            style={{
              display: "flex",
              gap: "16px",
              padding: "12px",
              background: "rgba(255, 255, 255, 0.05)",
              borderRadius: "12px",
              cursor: "pointer",
              transition: "background 0.2s ease, transform 0.2s ease",
              border: "1px solid rgba(255, 255, 255, 0.1)",
              position: "relative"
            }}
            onMouseEnter={async (e) => {
              e.currentTarget.style.background = "rgba(255, 255, 255, 0.1)";
              e.currentTarget.style.transform = "translateX(4px)";
              
              if (book.description) {
                  setTooltip({ visible: true, x: e.clientX, y: e.clientY, text: book.description, html: false, loading: false });
                  return;
              }
              
              const cacheKey = `${book.title}-${book.author}`;
              if (itunesCache[cacheKey]) {
                  setTooltip({ visible: true, x: e.clientX, y: e.clientY, text: itunesCache[cacheKey], html: true, loading: false });
                  return;
              }
              
              setTooltip({ visible: true, x: e.clientX, y: e.clientY, text: "Loading description...", html: false, loading: true });
              
              try {
                  const res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(book.title + ' ' + book.author)}&media=audiobook&limit=1`);
                  const data = await res.json();
                  if (data.results && data.results[0] && data.results[0].description) {
                      const desc = data.results[0].description;
                      setItunesCache(prev => ({...prev, [cacheKey]: desc}));
                      setTooltip(prev => prev?.visible ? { ...prev, text: desc, html: true, loading: false } : prev);
                  } else {
                      const desc = "No description available.";
                      setItunesCache(prev => ({...prev, [cacheKey]: desc}));
                      setTooltip(prev => prev?.visible ? { ...prev, text: desc, html: false, loading: false } : prev);
                  }
              } catch (err) {
                  const desc = "Failed to load description.";
                  setItunesCache(prev => ({...prev, [cacheKey]: desc}));
                  setTooltip(prev => prev?.visible ? { ...prev, text: desc, html: false, loading: false } : prev);
              }
            }}
            onMouseMove={e => {
                setTooltip(prev => prev?.visible ? { ...prev, x: e.clientX, y: e.clientY } : prev);
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = "rgba(255, 255, 255, 0.05)";
              e.currentTarget.style.transform = "translateX(0)";
              setTooltip(null);
            }}
          >
            {/* Rank Number */}
            <div style={{ 
              display: "flex", 
              alignItems: "center", 
              justifyContent: "center",
              minWidth: "24px",
              color: "var(--text-secondary)",
              fontWeight: "bold"
            }}>
              #{i + 1}
            </div>
            
            {/* Cover */}
            <div style={{
              width: "60px",
              height: "60px",
              borderRadius: "8px",
              flexShrink: 0,
              backgroundImage: book.coverUrl ? `url(${book.coverUrl})` : "linear-gradient(145deg, #1f1f1f, #2a2a2a)",
              backgroundSize: "cover",
              backgroundPosition: "center",
            }} />
            
            {/* Details */}
            <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", overflow: "hidden" }}>
              <div style={{ 
                fontWeight: "600", 
                color: "var(--text-primary)", 
                whiteSpace: "nowrap", 
                overflow: "hidden", 
                textOverflow: "ellipsis" 
              }}>
                {book.title}
              </div>
              <div style={{ 
                fontSize: "0.85rem", 
                color: "var(--primary-accent)",
                whiteSpace: "nowrap", 
                overflow: "hidden", 
                textOverflow: "ellipsis" 
              }}>
                {book.author}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div style={{ padding: "24px", paddingTop: "0" }}>
      <h2 style={{ 
        margin: "0 0 24px 0", 
        fontSize: "1.5rem", 
        fontWeight: "600",
        background: "linear-gradient(90deg, var(--primary-accent), var(--text-primary))",
        WebkitBackgroundClip: "text",
        WebkitTextFillColor: "transparent"
      }}>
        Top Bestsellers
      </h2>
      <style>{`.hide-scrollbar::-webkit-scrollbar { display: none; }`}</style>
      
      <div style={{ display: "flex", gap: "24px" }}>
        {renderList(audible, "Audible Bestsellers", "")}
        {renderList(abn, "AudiobooksNow Bestsellers", "")}
      </div>

      {tooltip && tooltip.visible && (
        <div style={{
          position: "fixed",
          top: Math.min(tooltip.y + 15, window.innerHeight - (tooltip.html ? 300 : 100)),
          left: Math.min(tooltip.x + 15, window.innerWidth - 320),
          maxWidth: "300px",
          maxHeight: "400px",
          overflowY: "auto",
          background: "rgba(20, 20, 20, 0.95)",
          backdropFilter: "blur(10px)",
          border: "1px solid rgba(255, 255, 255, 0.1)",
          borderRadius: "8px",
          padding: "12px",
          color: "#f3f4f6",
          fontSize: "0.85rem",
          lineHeight: "1.4",
          zIndex: 9999,
          pointerEvents: "none",
          boxShadow: "0 8px 32px rgba(0,0,0,0.5)"
        }}>
          <style>{`.tooltip-content * { color: #f3f4f6 !important; }`}</style>
          {tooltip.html ? (
            <div className="tooltip-content" dangerouslySetInnerHTML={{ __html: tooltip.text }} />
          ) : (
            <div className="tooltip-content">{tooltip.text}</div>
          )}
        </div>
      )}
    </div>
  );
};
