import React, { useEffect, useState, type FormEvent } from "react";
import { useLocation } from "react-router-dom";
import { errorMessage } from "@audioshelf/shared";
import { loadSettings, updateSettings } from "../settingsClient.js";
import { useWsEvent } from "../../contexts/WebSocketProvider.js";
import { useToast } from "../../features/curator/toast";
import { ScannerControl } from "../../features/librarian/components/ScannerControl.js";
import { ScanResultsReview } from "../../features/librarian/components/ScanResultsReview.js";

import { CollectionReviewPanel } from "./CollectionReviewPanel.js";

const IntakeProgressStrip: React.FC = () => {
  const toast = useToast();
  const [started, setStarted] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState("Idle");
  const [currentFile, setCurrentFile] = useState("");

  useWsEvent("librarian:scan_progress", (payload) => {
    setStarted(true);
    if (payload.total > 0) {
      setProgress((payload.scanned / payload.total) * 100);
    }
    setStatusText(payload.status.charAt(0).toUpperCase() + payload.status.slice(1));
    setCurrentFile(payload.currentFile);
  });

  useWsEvent("librarian:scan_warning", (payload) => {
    toast(payload.message, "warning");
  });

  if (!started && statusText === "Idle") return null;

  return (
    <div className="v2-intake-progress">
      <div className="v2-intake-progress-head"><span>Status: {statusText}</span><span>{statusText === 'Discovering' ? '...' : `${Math.round(progress)}%`}</span></div>
      <div className="v2-intake-progress-bar"><div className={statusText === 'Discovering' ? 'sweep' : ''} style={{ width: statusText === 'Discovering' ? '50%' : `${progress}%` }}/></div>
      <div className="v2-intake-progress-foot">
        <span>{currentFile ? (statusText === 'Discovering' ? `Discovering: ${currentFile}` : `Scanning: ${currentFile}`) : 'Ready…'}</span>
        {(statusText === 'Scanning' || statusText === 'Discovering') && <button className="v2-button-secondary" onClick={async () => { try { await fetch('/api/librarian/scan/cancel', { method: 'POST' }); } catch (e) { console.error("Failed to cancel scan", e); } }}>Cancel</button>}
      </div>
    </div>
  );
};

function IntakePolicy() {
  const [saved, setSaved] = useState<"review" | "automatic" | null>(null);
  const [mode, setMode] = useState<"review" | "automatic">("review");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let cancelled = false;
    void loadSettings().then(settings => {
      if (cancelled) return;
      const current = settings.collectionImportMode ?? "review";
      setSaved(current);
      setMode(current);
    }).catch(error => {
      if (!cancelled) setMessage(errorMessage(error));
    });
    return () => { cancelled = true; };
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!saved || saved === mode || busy) return;
    setMessage("");
    setBusy(true);
    try {
      const settings = await updateSettings({ collectionImportMode: mode });
      setSaved(settings.collectionImportMode);
      setMode(settings.collectionImportMode);
      setMessage("Collection import policy saved.");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return <section className="intake-policy" aria-labelledby="intake-policy-heading">
    <h2 id="intake-policy-heading">Collection import policy</h2>
    <p>Applies to new collections. Possible duplicates and unclear matches stay in review.</p>
    <form onSubmit={save}>
      <label>When a collection arrives
        <select className="glass-input" value={mode} disabled={busy || !saved} onChange={event => setMode(event.target.value === "automatic" ? "automatic" : "review")}>
          <option value="review">Review first</option>
          <option value="automatic">Auto-import clear matches</option>
        </select>
      </label>
      <button type="submit" className="v2-button-secondary" disabled={busy || !saved || saved === mode}>Save policy</button>
    </form>
    {message && <p role="status">{message}</p>}
  </section>;
}

export function IntakePanel() {
  const [planOnlySession, setPlanOnlySession] = useState<boolean | null>(null);
  const collectionId = new URLSearchParams(useLocation().search).get("collection") ?? undefined;

  return <>
    <CollectionReviewPanel initialCollectionId={collectionId} />
    <IntakePolicy/>
    <details className="v2-manual-scan">
      <summary>Advanced · Scan a directory<small>Preview or scan a folder outside the automatic intake flow.</small></summary>
      <ScannerControl onScanStarted={setPlanOnlySession}/>
    </details>
    <IntakeProgressStrip/>
    <ScanResultsReview planOnly={planOnlySession} onPlanOnlyDetected={setPlanOnlySession}/>
  </>;
}
