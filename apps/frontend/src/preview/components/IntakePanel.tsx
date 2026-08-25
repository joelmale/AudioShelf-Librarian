import React, { useState } from "react";
import { useWsEvent } from "../../contexts/WebSocketProvider.js";
import { useToast } from "../../features/curator/toast";
import { ScannerControl } from "../../features/librarian/components/ScannerControl.js";
import { ScanResultsReview } from "../../features/librarian/components/ScanResultsReview.js";

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

export function IntakePanel() {
  const [planOnlySession, setPlanOnlySession] = useState<boolean | null>(null);

  return <>
    <details className="v2-manual-scan">
      <summary>Scan a directory manually<small>The inbox is polled automatically every 5 minutes — this is only needed for a different directory or a dry run.</small></summary>
      <ScannerControl onScanStarted={setPlanOnlySession}/>
    </details>
    <IntakeProgressStrip/>
    <ScanResultsReview planOnly={planOnlySession} onPlanOnlyDetected={setPlanOnlySession}/>
  </>;
}
