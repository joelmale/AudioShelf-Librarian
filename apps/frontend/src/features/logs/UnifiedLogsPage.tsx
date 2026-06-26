import React, { useState } from "react";
import { LogPage as CuratorLogs } from "../curator/pages/LogPage.js";
import { OrganizationHistory as LibrarianLogs } from "../librarian/components/OrganizationHistory.js";

export const UnifiedLogsPage: React.FC = () => {
  const [activeTab, setActiveTab] = useState<"librarian" | "curator">("librarian");

  return (
    <div style={{ maxWidth: '900px', margin: '0 auto', padding: '24px 0' }}>
      <h2 style={{ marginBottom: '8px' }}>Activity Logs</h2>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '24px' }}>
        Monitor all system operations, background tasks, and bulk organizations.
      </p>

      <div style={{ display: 'flex', gap: '12px', marginBottom: '24px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '12px' }}>
        <button 
          className="glass-button" 
          onClick={() => setActiveTab("librarian")}
          style={{ 
            background: activeTab === "librarian" ? 'var(--primary-accent)' : 'transparent',
            color: activeTab === "librarian" ? 'var(--bg-primary)' : 'var(--text-primary)',
            borderColor: activeTab === "librarian" ? 'transparent' : 'rgba(255,255,255,0.2)'
          }}
        >
          Librarian History (Manual)
        </button>
        <button 
          className="glass-button" 
          onClick={() => setActiveTab("curator")}
          style={{ 
            background: activeTab === "curator" ? 'var(--primary-accent)' : 'transparent',
            color: activeTab === "curator" ? 'var(--bg-primary)' : 'var(--text-primary)',
            borderColor: activeTab === "curator" ? 'transparent' : 'rgba(255,255,255,0.2)'
          }}
        >
          Curator Logs (Automated)
        </button>
      </div>

      <div className="tab-content">
        {activeTab === "librarian" && (
          <div>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '16px' }}>
              History of all manual bulk folder organizations and metadata commits. You can undo batches here if files were moved to the wrong library path.
            </p>
            <LibrarianLogs />
          </div>
        )}
        {activeTab === "curator" && (
          <div>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '16px' }}>
              Real-time logs of automated background jobs including encoding, collections updates, and background metadata tag fetching.
            </p>
            <CuratorLogs />
          </div>
        )}
      </div>
    </div>
  );
};
