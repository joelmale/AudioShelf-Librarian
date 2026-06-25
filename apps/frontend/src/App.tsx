import React from "react";
import { Routes, Route, Link } from "react-router-dom";
import { WebSocketProvider } from "./contexts/WebSocketProvider.js";

import { LibrarianView } from "./features/librarian/LibrarianView.js";
import { App as CuratorApp } from "./features/curator/App.js";
import { SystemStatus } from "./features/system/SystemStatus.js";

export const App = () => {
  return (
    <WebSocketProvider>
      <div className="layout">
        <nav className="sidebar">
          <h1>AudioShelf</h1>
          <Link to="/">Librarian</Link>
          <Link to="/curator">Curator</Link>
          <Link to="/status">System Status</Link>
        </nav>
        <main className="content">
          <Routes>
            <Route path="/" element={<LibrarianView />} />
            <Route path="/curator/*" element={<CuratorApp />} />
            <Route path="/status" element={<SystemStatus />} />
          </Routes>
        </main>
      </div>
    </WebSocketProvider>
  );
};
