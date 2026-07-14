import React, { useState } from "react";
import { LogPage as CuratorLogs } from "../curator/pages/LogPage.js";
import { OrganizationHistory as LibrarianLogs } from "../librarian/components/OrganizationHistory.js";
import { SystemConsole } from "./SystemConsole.js";
import { Activity, Bot, FolderCog, Terminal } from "lucide-react";

export const UnifiedLogsPage: React.FC = () => {
  const [activeTab, setActiveTab] = useState<"librarian" | "curator" | "system">("librarian");

  return (
    <div className="v2-page v2-legacy-surface">
      <div className="v2-page-heading">
        <div>
          <span className="v2-eyebrow"><Activity className="inline-icon" size={16}/> Activity Logs</span>
          <h1>Monitor system operations</h1>
          <p>Review background tasks, automated curation, and bulk organizations.</p>
        </div>
        <span className="v2-live"><span className="v2-dot ok"/> Live system</span>
      </div>

      <nav className="v2-section-tabs" aria-label="Log sections">
        <button onClick={() => setActiveTab("librarian")} className={activeTab === "librarian" ? "active" : ""}><FolderCog/><span>Librarian History</span></button>
        <button onClick={() => setActiveTab("curator")} className={activeTab === "curator" ? "active" : ""}><Bot/><span>Curator Logs</span></button>
        <button onClick={() => setActiveTab("system")} className={activeTab === "system" ? "active" : ""}><Terminal/><span>System Console</span></button>
      </nav>

      <div className="tab-content" style={{ marginTop: '24px' }}>
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
        {activeTab === "system" && (
          <SystemConsole />
        )}
      </div>
    </div>
  );
};
