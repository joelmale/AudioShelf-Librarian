import { AlertTriangle, ArrowRight, CheckCircle2, Play, RefreshCw } from "lucide-react";
import React from "react";
import { api, type RealignExecution, useMutation, useRealignScan } from "../../features/curator/api.js";
import { useToast } from "../../features/curator/toast.js";

const MINIMUM_STRUCTURE_COVERAGE = 0.75;

function coverageLabel(eligible: number, observed: number, coverage: number): string {
  if (observed === 0) return "No books observed";
  return `${eligible}/${observed} eligible (${Math.round(coverage * 100)}% coverage)`;
}

export function RealignPage() {
  const scan = useRealignScan();
  const toast = useToast();
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [executionResult, setExecutionResult] = React.useState<RealignExecution | null>(null);
  const [now, setNow] = React.useState(Date.now());

  React.useEffect(() => { setSelected(new Set()); void scan.refetch(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  React.useEffect(() => {
    setSelected(new Set());
  }, [scan.data?.planId]);

  const plan = scan.data;
  const expired = Boolean(plan && Date.parse(plan.expiresAt) <= now);
  const gatedLibraries = plan?.libraries.filter((library) => library.status === "Unknown" || library.coverage < MINIMUM_STRUCTURE_COVERAGE) ?? [];
  const isCoverageGated = gatedLibraries.length > 0;
  const execute = useMutation({
    mutationFn: (bookIds: string[]) => {
      if (!plan) throw new Error("Run a scan before executing realignment.");
      return api.realignExecute({ planId: plan.planId, bookIds });
    },
    onSuccess: async (data) => {
      setExecutionResult(data);
      setSelected(new Set());
      const message = `${data.moved} moved, ${data.failed} failed${data.scanErrors.length ? `, ${data.scanErrors.length} rescan error${data.scanErrors.length === 1 ? "" : "s"}` : ""}.`;
      toast(message, data.failed || data.scanErrors.length ? "error" : "success");
      await scan.refetch();
    },
    onError: (error: Error) => toast(error.message, "error"),
  });

  const toggle = (bookId: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(bookId)) next.delete(bookId); else next.add(bookId);
    return next;
  });
  const rescan = () => {
    setSelected(new Set());
    void scan.refetch();
  };
  const disabled = !plan || expired || scan.isFetching || execute.isPending || selected.size === 0 || isCoverageGated;
  const executeError = execute.error instanceof Error ? execute.error.message : null;

  return <div className="v2-realign">
    <div className="v2-card">
      <div className="v2-card-head">
        <div>
          <h2>Proposed moves</h2>
          <p className="v2-muted">Paths are a review preview only. The server re-fetches each book and revalidates its source, destination, and confirmed convention before moving anything.</p>
        </div>
        <div className="v2-realign-actions">
          <button className="v2-button v2-button-secondary" disabled={scan.isFetching || execute.isPending} onClick={rescan}>
            <RefreshCw className={scan.isFetching ? "spin" : undefined} /> Rescan
          </button>
          <button className="v2-button v2-success" disabled={disabled} onClick={() => execute.mutate(Array.from(selected))}>
            {execute.isPending ? <Play className="spin"/> : <CheckCircle2/>}
            Execute {selected.size} {selected.size === 1 ? "move" : "moves"}
          </button>
        </div>
      </div>

      {(scan.isLoading || (scan.isFetching && !plan)) && <p>Scanning library for mismatches...</p>}
      {scan.isError && <p className="v2-realign-alert" role="alert"><AlertTriangle /> {scan.error instanceof Error ? scan.error.message : "The library scan failed."}</p>}
      {expired && <p className="v2-realign-alert" role="alert"><AlertTriangle /> This review plan expired. Rescan before selecting or executing moves.</p>}
      {executeError && <p className="v2-realign-alert" role="alert"><AlertTriangle /> {executeError}</p>}
      {executionResult && <div className="v2-realign-result" role="status">
        <strong>Last execution: {executionResult.moved} moved, {executionResult.failed} failed.</strong>
        {executionResult.errors.length > 0 && <p>{executionResult.errors.join(" · ")}</p>}
        {executionResult.scanErrors.length > 0 && <p>{executionResult.scanErrors.length} Audiobookshelf rescan {executionResult.scanErrors.length === 1 ? "error" : "errors"}: {executionResult.scanErrors.join(" · ")}</p>}
      </div>}

      {plan && <section className="v2-realign-measurements" aria-label="Library structure measurements">
        {plan.libraries.map((library) => <article key={library.libraryId} className={library.status === "Unknown" ? "unknown" : ""}>
          <div><strong>{library.name}</strong><small>{library.libraryId}</small></div>
          <span className={`v2-realign-status ${library.status.toLowerCase()}`}>{library.status === "Unknown" ? "Unknown / not measured" : `Configured · ${library.status} · ${library.score}%`}</span>
          <span>{coverageLabel(library.eligible, library.observed, library.coverage)}</span>
          <span>{library.issues == null ? `${Math.max(0, library.observed - library.eligible)} skipped or ineligible` : `${library.issues} issue${library.issues === 1 ? "" : "s"} · ${Math.max(0, library.observed - library.eligible)} skipped`}</span>
        </article>)}
      </section>}

      {plan && isCoverageGated && <p className="v2-realign-alert" role="alert"><AlertTriangle /> Execution is disabled because {gatedLibraries.map((library) => library.name).join(", ")} {gatedLibraries.length === 1 ? "is" : "are"} Unknown or below 75% measurement coverage. Confirm a folder convention in Settings, then rescan.</p>}

      {plan?.candidates.length === 0 && !isCoverageGated && <div className="v2-empty-compact"><h2>Measured and aligned</h2><p>Every measured, eligible book follows its confirmed library convention.</p></div>}
      {plan?.candidates.length === 0 && isCoverageGated && <div className="v2-empty-compact"><h2>No moves can be proposed yet</h2><p>At least one library was not measured, so this is not an “all clean” result.</p></div>}

      {plan && plan.candidates.length > 0 && <div className="v2-realign-list">
        {plan.candidates.map((item) => <label key={item.bookId} className="v2-realign-candidate">
          <input type="checkbox" checked={selected.has(item.bookId)} disabled={expired || scan.isFetching || execute.isPending || isCoverageGated} onChange={() => toggle(item.bookId)} aria-label={`Select ${item.title} for realignment`} />
          <div>
            <strong>{item.title} <span>by {item.author}</span></strong>
            <small>Stable Audiobookshelf ID: {item.bookId}</small>
            <div className="v2-path"><small>Current</small><code>{item.currentPath}</code></div>
            <ArrowRight className="v2-path-arrow" />
            <div className="v2-path"><small>Proposed</small><code>{item.proposedPath}</code></div>
          </div>
        </label>)}
      </div>}
    </div>
  </div>;
}
