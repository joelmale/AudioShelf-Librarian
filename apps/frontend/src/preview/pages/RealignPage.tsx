import { ArrowRight, CheckCircle2, Play } from "lucide-react";
import { api, useMutation, useRealignScan } from "../../features/curator/api.js";
import { useToast } from "../../features/curator/toast.js";

export function RealignPage() {
  const scan = useRealignScan();
  const toast = useToast();

  const execute = useMutation({
    mutationFn: (candidates: any[]) => api.realignExecute(candidates),
    onSuccess: (data) => {
      toast(`Successfully realigned ${data.success} books.`, "success");
      scan.refetch();
    },
    onError: (e: Error) => toast(e.message, "error")
  });

  return <div className="v2-realign">
    <div className="v2-card">
      <div className="v2-card-head">
        <h2>Proposed Moves</h2>
        <button
          className="v2-button v2-success"
          disabled={!scan.data?.results?.length || execute.isPending}
          onClick={() => execute.mutate(scan.data.results)}
        >
          {execute.isPending ? <Play className="spin"/> : <CheckCircle2/>}
          Execute {scan.data?.results?.length ?? 0} moves
        </button>
      </div>

      {scan.isLoading && <p>Scanning library for mismatches...</p>}
      
      {scan.data?.results?.length === 0 && (
        <div className="v2-empty-compact">
          <h2>All clean</h2>
          <p>Your library directory structure is perfectly aligned.</p>
        </div>
      )}

      {scan.data?.results && scan.data.results.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          {scan.data.results.map((item: any) => (
            <div key={item.bookId} style={{ background: "var(--bg-inset)", padding: "1rem", borderRadius: "8px" }}>
              <div style={{ fontWeight: 600, marginBottom: "0.5rem" }}>{item.title} <span style={{ fontWeight: 400, color: "var(--text-muted)" }}>by {item.author}</span></div>
              <div className="v2-path"><small>Current</small><code>{item.currentPath}</code></div>
              <ArrowRight className="v2-path-arrow" style={{ margin: "0.5rem 0" }} />
              <div className="v2-path"><small>Proposed</small><code>{item.proposedPath}</code></div>
            </div>
          ))}
        </div>
      )}
    </div>
  </div>;
}
