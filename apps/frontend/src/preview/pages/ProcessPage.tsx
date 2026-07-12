import { ScannerControl } from "../../features/librarian/components/ScannerControl.js";
import { ProgressTracker } from "../../features/librarian/components/ProgressTracker.js";
import { ScanResultsReview } from "../../features/librarian/components/ScanResultsReview.js";

export function ProcessPage({ mode }: { mode: "scan" | "review" }) {
  return <div className="v2-page v2-legacy-surface">
    <div className="v2-page-heading"><div><span className="v2-eyebrow">Filesystem process</span><h1>{mode === "scan" ? "Scan an intake directory" : "Review proposed changes"}</h1><p>These controls are connected to the live system. Review paths and counts before committing changes.</p></div><span className="v2-live warning"><span className="v2-dot warn"/> Live filesystem</span></div>
    {mode === "scan" && <ScannerControl/>}<ProgressTracker/><ScanResultsReview/>
  </div>;
}
