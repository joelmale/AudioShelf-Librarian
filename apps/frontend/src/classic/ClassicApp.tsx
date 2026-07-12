import { Link, Navigate, Route, Routes } from "react-router-dom";
import { LibrarianView } from "../features/librarian/LibrarianView.js";
import { App as CuratorApp } from "../features/curator/App.js";
import { SystemStatus } from "../features/system/SystemStatus.js";
import { SettingsPage } from "../features/system/SettingsPage.js";
import { UnifiedLogsPage } from "../features/logs/UnifiedLogsPage.js";

export default function ClassicApp() {
  return (
    <div className="layout">
      <nav className="sidebar" aria-label="Classic navigation">
        <h1>AudioShelf</h1>
        <Link to="/classic">Librarian</Link>
        <Link to="/classic/curator">Curator</Link>
        <Link to="/classic/logs">Activity Logs</Link>
        <Link to="/classic/status">System Status</Link>
        <Link to="/classic/settings">Settings</Link>
        <Link to="/preview/desk" className="preview-link">Return to UI v2</Link>
      </nav>
      <main className="content">
        <Routes>
          <Route index element={<LibrarianView />} />
          <Route path="curator/*" element={<CuratorApp basePath="/classic/curator" />} />
          <Route path="logs/*" element={<UnifiedLogsPage />} />
          <Route path="status" element={<SystemStatus />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/classic" replace />} />
        </Routes>
      </main>
    </div>
  );
}
