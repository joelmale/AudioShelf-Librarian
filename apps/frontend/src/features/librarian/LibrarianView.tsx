import React from "react";
import { ScannerControl } from "./components/ScannerControl.js";
import { ProgressTracker } from "./components/ProgressTracker.js";
import { ScanResultsReview } from "./components/ScanResultsReview.js";
import { AudiobookSearch } from "./components/AudiobookSearch.js";
import { BestsellerLists } from "./components/BestsellerLists.js";
import { Copy } from "lucide-react";
import { useToast } from "../curator/toast";

export const LibrarianView: React.FC = () => {
  const [copying, setCopying] = React.useState(false);
  const toast = useToast();

  const copyTitles = async () => {
    try {
      setCopying(true);






      const response = await fetch('/api/books/titles');
      if (!response.ok) throw new Error("Failed to fetch titles");
      const titles: string[] = await response.json();
      await navigator.clipboard.writeText(titles.join('\n'));
      toast(`Copied ${titles.length} book titles to clipboard!`, "success");
    } catch (e) {
      toast("Failed to copy titles.", "error");
      console.error(e);
    } finally {
      setCopying(false);
    }
  };

  return (
    <div style={{ maxWidth: '800px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>Librarian Core</h2>
        <button 
          className="btn secondary" 
          onClick={copyTitles} 
          disabled={copying}
          style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
        >
          <Copy size={16} />
          {copying ? 'Copying...' : 'Copy All Titles'}
        </button>
      </div>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '32px', marginTop: 0 }}>
        Scan, parse, and organize your audiobook collection natively in the browser.
      </p>

      <ScannerControl />
      <ProgressTracker />
      <ScanResultsReview />
      <AudiobookSearch />
      <BestsellerLists />
    </div>
  );
};
