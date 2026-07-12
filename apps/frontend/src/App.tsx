import React, { Suspense } from "react";
import { Routes, Route, Link } from "react-router-dom";
import { WebSocketProvider } from "./contexts/WebSocketProvider.js";

import { LibrarianView } from "./features/librarian/LibrarianView.js";
import { App as CuratorApp } from "./features/curator/App.js";
import { SystemStatus } from "./features/system/SystemStatus.js";
import { SettingsPage } from "./features/system/SettingsPage.js";
import { UnifiedLogsPage } from "./features/logs/UnifiedLogsPage.js";

const PreviewApp = React.lazy(() => import("./preview/PreviewApp.js"));

const LegacyApp = () => {
  return (
    <div className="layout">
        <nav className="sidebar">
          <h1>AudioShelf</h1>
          <Link to="/">Librarian</Link>
          <Link to="/curator">Curator</Link>
          <Link to="/logs">Activity Logs</Link>
          <Link to="/status">System Status</Link>
          <Link to="/settings">Settings</Link>
          <Link to="/preview/desk" className="preview-link">Try UI Preview</Link>
        </nav>
        <main className="content">
          <Routes>
            <Route path="/" element={<LibrarianView />} />
            <Route path="/curator/*" element={<CuratorApp />} />
            <Route path="/logs/*" element={<UnifiedLogsPage />} />
            <Route path="/status" element={<SystemStatus />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </main>
      </div>
  );
};

export const App = () => (
  <WebSocketProvider>
    <Routes>
      <Route
        path="/preview/*"
        element={
          <Suspense fallback={<div className="preview-loading">Loading UI preview…</div>}>
            <PreviewApp />
          </Suspense>
        }
      />
      <Route path="*" element={<LegacyApp />} />
    </Routes>
  </WebSocketProvider>
);
