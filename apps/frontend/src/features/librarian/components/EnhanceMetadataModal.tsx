import React, { useState } from "react";
import type { OrganizationAction, Book } from "@audioshelf/shared";

interface EnhanceMetadataModalProps {
  original: OrganizationAction;
  suggested: OrganizationAction;
  onAccept: (action: OrganizationAction) => void;
  onReject: () => void;
}

export const EnhanceMetadataModal: React.FC<EnhanceMetadataModalProps> = ({
  original,
  suggested,
  onAccept,
  onReject,
}) => {
  const [editedBook, setEditedBook] = useState<Book>(suggested.book);

  const handleChange = (field: keyof Book, value: any) => {
    setEditedBook((prev) => ({ ...prev, [field]: value }));
  };

  const handleAuthorsChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const arr = e.target.value.split(",").map((a) => a.trim()).filter(Boolean);
    handleChange("authors", arr.length > 0 ? arr : ["Unknown Author"]);
  };

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(0, 0, 0, 0.6)",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        zIndex: 1000,
        backdropFilter: "blur(4px)",
      }}
    >
      <div
        className="glass-panel"
        style={{
          width: "90%",
          maxWidth: "600px",
          maxHeight: "90vh",
          overflowY: "auto",
          padding: "24px",
          boxShadow: "0 10px 40px rgba(0,0,0,0.5)",
        }}
      >
        <h2 style={{ marginTop: 0, marginBottom: "24px" }}>Review AI Suggestion</h2>
        
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          
          {/* Title */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
            <div>
              <label style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>Original Title</label>
              <div style={{ padding: "8px", background: "rgba(255,255,255,0.05)", borderRadius: "4px" }}>
                {original.book.title}
              </div>
            </div>
            <div>
              <label style={{ fontSize: "0.8rem", color: "var(--primary-accent)" }}>Suggested Title</label>
              <input 
                className="glass-input"
                value={editedBook.title} 
                onChange={(e) => handleChange("title", e.target.value)}
                style={{ width: "100%", boxSizing: "border-box" }}
              />
            </div>
          </div>

          {/* Authors */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
            <div>
              <label style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>Original Author</label>
              <div style={{ padding: "8px", background: "rgba(255,255,255,0.05)", borderRadius: "4px" }}>
                {original.book.authors.join(", ")}
              </div>
            </div>
            <div>
              <label style={{ fontSize: "0.8rem", color: "var(--primary-accent)" }}>Suggested Author</label>
              <input 
                className="glass-input"
                value={editedBook.authors.join(", ")} 
                onChange={handleAuthorsChange}
                style={{ width: "100%", boxSizing: "border-box" }}
              />
            </div>
          </div>

          {/* Series */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
            <div>
              <label style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>Original Series</label>
              <div style={{ padding: "8px", background: "rgba(255,255,255,0.05)", borderRadius: "4px" }}>
                {original.book.series || "-"}
              </div>
            </div>
            <div>
              <label style={{ fontSize: "0.8rem", color: "var(--primary-accent)" }}>Suggested Series</label>
              <input 
                className="glass-input"
                value={editedBook.series || ""} 
                onChange={(e) => handleChange("series", e.target.value || null)}
                style={{ width: "100%", boxSizing: "border-box" }}
              />
            </div>
          </div>

          {/* Series Number & Year */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
            <div>
              <label style={{ fontSize: "0.8rem", color: "var(--primary-accent)" }}>Series Number</label>
              <input 
                className="glass-input"
                type="number"
                step="0.1"
                value={editedBook.series_number || ""} 
                onChange={(e) => handleChange("series_number", e.target.value ? parseFloat(e.target.value) : null)}
                style={{ width: "100%", boxSizing: "border-box" }}
              />
            </div>
            <div>
              <label style={{ fontSize: "0.8rem", color: "var(--primary-accent)" }}>Published Year</label>
              <input 
                className="glass-input"
                type="number"
                value={editedBook.published_year || ""} 
                onChange={(e) => handleChange("published_year", e.target.value ? parseInt(e.target.value, 10) : null)}
                style={{ width: "100%", boxSizing: "border-box" }}
              />
            </div>
          </div>

        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px", marginTop: "32px" }}>
          <button 
            className="glass-button" 
            onClick={onReject}
            style={{ background: "rgba(255,255,255,0.1)" }}
          >
            Reject
          </button>
          <button 
            className="glass-button primary" 
            onClick={() => onAccept({ ...suggested, book: editedBook })}
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
};
