import React from "react";
import { ScannerControl } from "./components/ScannerControl.js";
import { ProgressTracker } from "./components/ProgressTracker.js";
import { AudiobookSearch } from "./components/AudiobookSearch.js";

export const LibrarianView: React.FC = () => {
  return (
    <div style={{ maxWidth: '800px', margin: '0 auto' }}>
      <h2>Librarian Core</h2>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '32px' }}>
        Scan, parse, and organize your audiobook collection natively in the browser.
      </p>

      <ScannerControl />
      <ProgressTracker />
      <AudiobookSearch />
    </div>
  );
};
