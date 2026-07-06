import React, { useState, useEffect } from "react";
import { useToast } from "../../curator/toast";

interface PopularBook {
  title: string;
  rawText: string;
  url: string;
  coverUrl: string;
  description: string;
  author: string;
}

export const PopularAudiobooks: React.FC = () => {
  const [books, setBooks] = useState<PopularBook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloadingUrl, setDownloadingUrl] = useState<string | null>(null);
  const [sentUrls, setSentUrls] = useState<Set<string>>(new Set());

  const toast = useToast();

  useEffect(() => {
    const fetchPopular = async () => {
      try {
        const res = await fetch("/api/librarian/abb/popular");
        if (!res.ok) throw new Error("Failed to fetch popular books");
        const data = await res.json();
        setBooks(data.results || []);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    fetchPopular();
  }, []);

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

  if (loading) {
    return (
      <div style={{ padding: "24px", color: "var(--text-secondary)" }}>
        Loading trending audiobooks...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: "24px", color: "var(--secondary-accent)" }}>
        Error loading popular books: {error}
      </div>
    );
  }

  if (books.length === 0) {
    return null;
  }

  return (
    <div style={{ padding: "24px", paddingTop: "0" }}>
      <h2 style={{ 
        margin: "0 0 16px 0", 
        fontSize: "1.5rem", 
        fontWeight: "600",
        background: "linear-gradient(90deg, #fff, var(--text-secondary))",
        WebkitBackgroundClip: "text",
        WebkitTextFillColor: "transparent"
      }}>
        Trending on Audiobookbay
      </h2>
      
      <div style={{
        display: "flex",
        overflowX: "auto",
        gap: "24px",
        paddingBottom: "24px",
        scrollSnapType: "x mandatory",
        WebkitOverflowScrolling: "touch",
        /* Hide scrollbar for a cleaner look */
        scrollbarWidth: "none",
        msOverflowStyle: "none"
      }}
      className="hide-scrollbar"
      >
        <style>{`.hide-scrollbar::-webkit-scrollbar { display: none; }`}</style>
        
        {books.map((book, i) => (
          <div 
            key={i}
            style={{
              flex: "0 0 220px",
              scrollSnapAlign: "start",
              position: "relative",
              borderRadius: "16px",
              overflow: "hidden",
              background: "rgba(255, 255, 255, 0.05)",
              boxShadow: "0 10px 30px rgba(0,0,0,0.3)",
              cursor: "pointer",
              transition: "transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.3s ease",
              aspectRatio: "2/3",
              border: "1px solid rgba(255, 255, 255, 0.1)"
            }}
            className="book-card"
          >
            <style>{`
              .book-card:hover {
                transform: translateY(-8px);
                box-shadow: 0 16px 40px rgba(0,0,0,0.5);
              }
              .book-card:hover .book-cover {
                opacity: 0.1;
                transform: scale(1.05);
              }
              .book-card:hover .book-details {
                opacity: 1;
                transform: translateY(0);
              }
            `}</style>
            
            {/* Cover Image */}
            <div 
              className="book-cover"
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundImage: book.coverUrl ? `url(${book.coverUrl})` : "linear-gradient(145deg, #1f1f1f, #2a2a2a)",
                backgroundSize: "cover",
                backgroundPosition: "center",
                transition: "all 0.4s cubic-bezier(0.4, 0, 0.2, 1)",
                zIndex: 1
              }}
            >
              {!book.coverUrl && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', padding: '20px', textAlign: 'center', color: 'var(--text-secondary)' }}>
                  {book.title}
                </div>
              )}
            </div>

            {/* Hover Details */}
            <div 
              className="book-details"
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                padding: "20px",
                display: "flex",
                flexDirection: "column",
                opacity: 0,
                transform: "translateY(20px)",
                transition: "all 0.4s cubic-bezier(0.4, 0, 0.2, 1)",
                zIndex: 2,
                background: "linear-gradient(to top, rgba(0,0,0,0.95), rgba(0,0,0,0.7))",
              }}
            >
              <div style={{ flex: 1, overflowY: "auto", paddingRight: "4px" }}>
                <h3 style={{ margin: "0 0 8px 0", fontSize: "1.1rem", fontWeight: "700", lineHeight: "1.2" }}>
                  {book.title}
                </h3>
                <p style={{ margin: "0 0 12px 0", fontSize: "0.85rem", color: "var(--primary-accent)", fontWeight: "600" }}>
                  {book.author}
                </p>
                <p style={{ margin: "0", fontSize: "0.8rem", color: "var(--text-secondary)", lineHeight: "1.4", opacity: 0.9 }}>
                  {book.description ? (book.description.length > 200 ? book.description.substring(0, 197) + "..." : book.description) : "No description available."}
                </p>
              </div>
              
              <button 
                disabled={downloadingUrl === book.url || sentUrls.has(book.url)}
                onClick={() => handleDownload(book.url)}
                style={{
                  display: "block",
                  padding: "10px",
                  background: "var(--primary-accent)",
                  color: "var(--bg-primary)",
                  textAlign: "center",
                  borderRadius: "8px",
                  textDecoration: "none",
                  fontWeight: "bold",
                  fontSize: "0.9rem",
                  marginTop: "12px",
                  boxShadow: "0 4px 12px rgba(var(--primary-accent-rgb), 0.3)",
                  border: "none",
                  cursor: (downloadingUrl === book.url || sentUrls.has(book.url)) ? "not-allowed" : "pointer",
                  opacity: (downloadingUrl === book.url || sentUrls.has(book.url)) ? 0.7 : 1
                }}
              >
                {downloadingUrl === book.url 
                  ? "Sending..." 
                  : sentUrls.has(book.url)
                    ? "Download sent"
                    : "Download on ABB"
                }
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
