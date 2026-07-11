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
    // ABB's search often fails (and returns the homepage) if the query is too specific.
    // Searching just by the main title (stripping subtitles after a colon) yields much better results.
    const mainTitle = book.title.split(':')[0].trim();
    const query = `${mainTitle}`;
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
              border: "1px solid rgba(255, 255, 255, 0.1)"
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = "rgba(255, 255, 255, 0.1)";
              e.currentTarget.style.transform = "translateX(4px)";
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = "rgba(255, 255, 255, 0.05)";
              e.currentTarget.style.transform = "translateX(0)";
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
    </div>
  );
};
