import { BookCopy, CheckCircle2, CircleAlert, CloudDownload, FolderInput, Library, LoaderCircle, Moon, RefreshCw, Sun, Tags, WandSparkles, AlertCircle, Download } from "lucide-react";
import { Link } from "react-router-dom";
import { api, useAcquisitionPipeline, useCollections, useEncodeQueue, useHealth, useLog, useMutation, useOperations, useTagStats, useLibraryHealth, useRealignScan, useRecentlyAdded } from "../../features/curator/api.js";
import { useToast } from "../../features/curator/toast.js";

/**
 * One tier -> one presentation, used for both the icon and the label.
 *
 * These previously disagreed: the icon was green only for exactly 'Great'
 * while the text was red only for 'Attention', so a 'Good' metric rendered a
 * red alert next to the word "Good" in the ok colour. The backend grades on
 * three tiers, so the UI needs three.
 */
const HEALTH_TIERS: Record<string, { Icon: typeof CheckCircle2; color: string }> = {
  Great: { Icon: CheckCircle2, color: '#10b981' },
  Clean: { Icon: CheckCircle2, color: '#10b981' },
  Good: { Icon: CircleAlert, color: '#f59e0b' },
  Attention: { Icon: AlertCircle, color: '#ef4444' },
  Unknown: { Icon: CircleAlert, color: 'var(--v2-dim)' },
};

interface LibraryHealthTotals {
  books: number;
  completeMetadata: number;
  m4b: number;
  structureIssues: number;
  duplicates: number;
}

/** Rows for the health panel, each carrying the count that explains its tier. */
function healthRows(data: { health?: Record<string, { status: string }>; totals?: LibraryHealthTotals }) {
  const h = data.health ?? {};
  const t = data.totals;
  const of = (n: number | undefined) => (t && n !== undefined ? `${n}/${t.books}` : '');
  return [
    { label: 'Metadata in ABS', status: h.metadata?.status ?? 'Unknown', detail: of(t?.completeMetadata) },
    { label: 'M4B files', status: h.files?.status ?? 'Unknown', detail: of(t?.m4b) },
    { label: 'Structure', status: h.structure?.status ?? 'Unknown', detail: t ? `${t.structureIssues} misaligned` : '' },
    { label: 'Duplicates', status: h.duplicates?.status ?? 'Unknown', detail: t ? `${t.duplicates} found` : '' },
  ];
}

export function DeskPage() {
  const health = useHealth();
  const libHealth = useLibraryHealth();
  const realignScan = useRealignScan();
  const recentlyAdded = useRecentlyAdded();
  const stats = useTagStats();
  const collections = useCollections();
  const operations = useOperations();
  const queue = useEncodeQueue();
  const acquisitions = useAcquisitionPipeline();
  const log = useLog();
  const toast = useToast();

  const sync = useMutation({ mutationFn: api.sync, onSuccess: () => toast("Pulling library from Audiobookshelf", "success"), onError: (e: Error) => toast(e.message, "error") });
  const active = (operations.data ?? []).find((op) => !["completed","cancelled","error"].includes(op.status));
  const pct = active?.progress.total ? Math.round(active.progress.current / active.progress.total * 100) : 0;
  const proposed = (collections.data ?? []).filter((c) => c.status === "proposed").length;
  const reviewCount = (stats.data?.untaggedBooks ?? 0) + proposed;
  const acquisitionStages = [
    { key: "downloading", label: "Downloading", icon: Download, entries: acquisitions.data?.downloading ?? [], empty: "No transfers in progress" },
    { key: "processing", label: "Processing", icon: LoaderCircle, entries: acquisitions.data?.processing ?? [], empty: "Inbox is caught up" },
    { key: "input", label: "Requires Input", icon: CircleAlert, entries: acquisitions.data?.requiresInput ?? [], empty: "Nothing needs attention" },
    { key: "shelved", label: "Shelved <24h", icon: Library, entries: acquisitions.data?.shelved24h ?? [], empty: "Nothing shelved today" },
  ];

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const GreetingIcon = hour < 18 ? Sun : Moon;

  return <div className="v2-page">
    <div className="v2-page-heading">
      <div>
        <span className="v2-eyebrow" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <GreetingIcon size={16} /> {greeting}
        </span>
        <h1>Your library. Your data. Always local.</h1>
        <p>Evidence-backed recommendations and live work across your sidecar.</p>
      </div>
      <span className="v2-live">
        <span className={`v2-dot ${health.data?.absConnected ? "ok" : "bad"}`}/> Live system
      </span>
    </div>
    <div className="v2-bento">
      <section className="v2-card v2-health">
        <style>{`
          .health-dial-container { position: relative; width: 100px; height: 100px; flex-shrink: 0; }
          .health-dial-svg { transform: rotate(-90deg); width: 100px; height: 100px; }
          .health-dial-bg { fill: none; stroke: var(--bg-card); stroke-width: 8; }
          .health-dial-fg { fill: none; stroke: var(--cyan); stroke-width: 8; stroke-linecap: round; transition: stroke-dasharray 1s ease-out; }
          .health-dial-text { position: absolute; top: 0; left: 0; right: 0; bottom: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
          .health-dial-score { font-size: 2.2rem; font-weight: 700; line-height: 1; color: var(--text-primary); }
          .health-dial-label { font-size: 0.75rem; color: var(--cyan); font-weight: 600; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
        `}</style>
        <div className="v2-card-head"><span className="v2-kicker cyan"><CheckCircle2/> Library health</span></div>

        {libHealth.isPending && (
          <p className="v2-muted" style={{ margin: '1rem 0', display: 'flex', alignItems: 'center', gap: 8 }}>
            <LoaderCircle size={14} className="spin" /> Checking your library…
          </p>
        )}

        {libHealth.isError && (
          <p style={{ margin: '1rem 0', display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: '0.9rem' }}>
            <AlertCircle size={14} color="#f59e0b" style={{ flexShrink: 0, marginTop: 2 }} />
            <span>
              <strong>Couldn&apos;t read library health.</strong>
              <span className="v2-muted" style={{ display: 'block', marginTop: 2 }}>
                {(libHealth.error as Error)?.message ?? 'The check did not complete.'}
              </span>
            </span>
          </p>
        )}

        {libHealth.data && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '2rem', marginTop: '1rem', padding: '0 0.5rem' }}>

          <div className="health-dial-container">
            <svg className="health-dial-svg" viewBox="0 0 100 100">
              <circle className="health-dial-bg" cx="50" cy="50" r="42" />
              <circle className="health-dial-fg" cx="50" cy="50" r="42" style={{ strokeDasharray: `${(libHealth.data.overallScore ?? 0) / 100 * 263.89} 263.89` }} />
            </svg>
            <div className="health-dial-text">
              <span className="health-dial-score">{libHealth.data.overallScore ?? 0}</span>
              <span className="health-dial-label">{(libHealth.data.overallScore ?? 0) >= 90 ? 'Excellent' : (libHealth.data.overallScore ?? 0) >= 75 ? 'Good' : 'Fair'}</span>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', flex: 1 }}>
            {healthRows(libHealth.data).map((row) => {
              const tier = HEALTH_TIERS[row.status] ?? HEALTH_TIERS.Unknown;
              return (
                <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.9rem' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-secondary)' }}>
                    <tier.Icon size={14} color={tier.color} /> {row.label}
                  </span>
                  <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span className="v2-muted" style={{ fontSize: '0.78rem' }}>{row.detail}</span>
                    <strong style={{ color: tier.color }}>{row.status}</strong>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        )}

        <div style={{ marginTop: '1.5rem' }}>
          <Link to="/curate/health" className="v2-button v2-button-secondary" style={{ width: '100%', justifyContent: 'center' }}>
            View full report &gt;
          </Link>
        </div>
      </section>
      <section className="v2-card v2-review"><div className="v2-card-head"><span className="v2-kicker warning"><CheckCircle2/> Needs review</span><strong className="v2-big-number">{reviewCount}</strong></div><Link className="v2-metric" to="/curate/tags"><span><Tags/><b>Metadata & tags</b></span><strong>{stats.data?.untaggedBooks ?? "—"}</strong></Link><Link className="v2-metric" to="/curate/collections"><span><BookCopy/><b>Collection proposals</b></span><strong>{proposed}</strong></Link></section>
      <section className="v2-card v2-active"><span className="v2-kicker cyan"><WandSparkles/> Active work</span>{active ? <><div className="v2-progress-title"><div><h2>{active.type}</h2><p>{active.progress.message || active.status}</p></div><strong>{pct}%</strong></div><div className="v2-progress"><i style={{"--progress": `${pct}%`} as React.CSSProperties}/></div><Link className="v2-button v2-button-secondary" to={`/activity/${active.id}`}>View operation</Link></> : <div className="v2-empty-compact"><h2>Everything is quiet</h2><p>No scan, curation, or conversion job is currently running.</p><Link to="/curate/encode">Review M4B candidates</Link></div>}</section>
      <section className="v2-card v2-plan">
        <span className="v2-kicker"><FolderInput/> Directory organization</span>
        <h2>{realignScan.data?.results?.length ?? 0} books misaligned</h2>
        <p style={{ marginBottom: '1rem', color: 'var(--text-muted)' }}>Keep your files structured cleanly according to your preferences.</p>
        <Link className="v2-button v2-button-secondary" to="/process/realign">Review proposed changes</Link>
      </section>
      
      <section className="v2-card v2-downloads">
        <div className="v2-card-head">
          <div><span className="v2-kicker cyan"><Download/> Acquisitions Queue</span><h2>From found to safely shelved</h2></div>
          <span className="v2-pipeline-live"><span className={`v2-dot ${acquisitions.isError ? "bad" : "ok"}`}/>{acquisitions.isError ? "Unavailable" : "Live"}</span>
        </div>
        <div className="v2-acquisition-pipeline" aria-label="Acquisition progress">
          {acquisitionStages.map((stage, index) => {
            const Icon = stage.icon;
            const sample = stage.entries[0];
            const isAttention = stage.key === "input" && stage.entries.length > 0;
            const isActive = stage.entries.length > 0;
            return <div className="v2-pipeline-segment" key={stage.key}>
              <div className={`v2-pipeline-stage ${isActive ? "active" : "idle"} ${isAttention ? "attention" : ""}`}>
                <div className="v2-pipeline-node"><Icon/><strong>{stage.entries.length}</strong></div>
                <div className="v2-pipeline-copy">
                  <b>{stage.label}</b>
                  <span>{sample ? sample.title : stage.empty}</span>
                  <small>{sample ? (stage.key === "downloading" ? `${sample.progress}% · ${sample.detail}` : sample.detail) : "Waiting for the next book"}</small>
                </div>
                {stage.key === "input" && stage.entries.length > 0 && <Link to="/process/organize">Review</Link>}
              </div>
              {index < acquisitionStages.length - 1 && <div className={`v2-pipeline-connector ${isActive || acquisitionStages[index + 1].entries.length > 0 ? "passed" : ""}`} aria-hidden="true"><i/></div>}
            </div>;
          })}
        </div>
        <div className="v2-pipeline-footer">
          <span>{acquisitions.data?.requiresInput.length ? `${acquisitions.data.requiresInput.length} acquisition${acquisitions.data.requiresInput.length === 1 ? "" : "s"} paused safely for your decision.` : "Acquisitions advance automatically when each step completes."}</span>
          <Link to="/scout/search">Find another book</Link>
        </div>
      </section>

      <section className="v2-card v2-sync"><div><span className="v2-kicker success"><CloudDownload/> Audiobookshelf</span><h2>{health.data?.absConnected ? "Connected and ready" : "Connection needs attention"}</h2><p>Pull every book from Audiobookshelf into the local mirror. Safe to re-run — books are matched on their Audiobookshelf id, so nothing is duplicated and nothing is written back.</p></div><button className="v2-button v2-success" disabled={sync.isPending || !health.data?.absConnected} onClick={() => sync.mutate()}>{sync.isPending ? <RefreshCw className="spin"/> : <CloudDownload/>} Sync from Audiobookshelf</button></section>
      <aside className="v2-card v2-queue"><div className="v2-card-head"><span className="v2-kicker">Task queue</span><b>{queue.data?.length ?? 0}</b></div>{(queue.data ?? []).slice(0,4).map((item) => <Link key={item.id} className="v2-queue-row" to="/curate/encode"><span><WandSparkles/><span><b>{item.name}</b><small>{item.status}</small></span></span><i className={`v2-status ${item.status}`}/></Link>)}{(queue.data ?? []).length === 0 && <p className="v2-muted">No conversion jobs queued.</p>}<h3>Recent audit</h3>{(log.data ?? []).slice(0,4).map((entry) => <div className="v2-audit" key={entry.id}><CheckCircle2/><span><b>{entry.operation}</b><small>{new Date(entry.startedAt).toLocaleString()}</small></span></div>)}</aside>
    </div>
    
    <div style={{ marginTop: '2rem' }}>
      <h2 style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>Recently added</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '1rem' }}>
        {(recentlyAdded.data?.results ?? []).map((item: any) => (
          <div key={item.id} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div style={{ aspectRatio: '1/1.5', background: 'var(--bg-card)', borderRadius: '6px', overflow: 'hidden' }}>
              {item.coverUrl ? <img src={item.coverUrl} alt={item.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : null}
            </div>
            <div>
              <div style={{ fontWeight: 600, fontSize: '0.9rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.title}</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.author}</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{new Date(item.addedAt).toLocaleDateString()}</div>
            </div>
          </div>
        ))}
        {(!recentlyAdded.data?.results || recentlyAdded.data.results.length === 0) && (
          <p style={{ color: 'var(--text-muted)', gridColumn: '1 / -1' }}>No recently added books found.</p>
        )}
      </div>
    </div>
  </div>;
}
