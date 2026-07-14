import { BookCopy, CheckCircle2, CloudUpload, FolderInput, Moon, RefreshCw, Sun, Tags, WandSparkles, AlertCircle } from "lucide-react";
import { Link } from "react-router-dom";
import { api, useCollections, useEncodeQueue, useHealth, useLog, useMutation, useOperations, useTagStats, useLibraryHealth, useRealignScan, useRecentlyAdded } from "../../features/curator/api.js";
import { useToast } from "../../features/curator/toast.js";

export function DeskPage() {
  const health = useHealth();
  const libHealth = useLibraryHealth();
  const realignScan = useRealignScan();
  const recentlyAdded = useRecentlyAdded();
  const stats = useTagStats();
  const collections = useCollections();
  const operations = useOperations();
  const queue = useEncodeQueue();
  const log = useLog();
  const toast = useToast();
  const sync = useMutation({ mutationFn: api.sync, onSuccess: () => toast("Audiobookshelf sync started", "success"), onError: (e: Error) => toast(e.message, "error") });
  const active = (operations.data ?? []).find((op) => !["completed","cancelled","error"].includes(op.status));
  const pct = active?.progress.total ? Math.round(active.progress.current / active.progress.total * 100) : 0;
  const proposed = (collections.data ?? []).filter((c) => c.status === "proposed").length;
  const reviewCount = (stats.data?.untaggedBooks ?? 0) + proposed;

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
        
        <div style={{ display: 'flex', alignItems: 'center', gap: '2rem', marginTop: '1rem', padding: '0 0.5rem' }}>
          
          <div className="health-dial-container">
            <svg className="health-dial-svg" viewBox="0 0 100 100">
              <circle className="health-dial-bg" cx="50" cy="50" r="42" />
              <circle className="health-dial-fg" cx="50" cy="50" r="42" style={{ strokeDasharray: `${(libHealth.data?.overallScore ?? 0) / 100 * 263.89} 263.89` }} />
            </svg>
            <div className="health-dial-text">
              <span className="health-dial-score">{libHealth.data?.overallScore ?? 0}</span>
              <span className="health-dial-label">{(libHealth.data?.overallScore ?? 0) >= 90 ? 'Excellent' : (libHealth.data?.overallScore ?? 0) >= 75 ? 'Good' : 'Fair'}</span>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', flex: 1 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.9rem' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-secondary)' }}>
                {libHealth.data?.health?.metadata.status === 'Great' ? <CheckCircle2 size={14} color="#10b981" /> : <AlertCircle size={14} color="#ef4444" />} Metadata
              </span>
              <strong className={libHealth.data?.health?.metadata.status === 'Attention' ? 'bad' : 'ok'}>{libHealth.data?.health?.metadata.status}</strong>
            </div>
            
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.9rem' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-secondary)' }}>
                {libHealth.data?.health?.files.status === 'Great' ? <CheckCircle2 size={14} color="#10b981" /> : <AlertCircle size={14} color="#ef4444" />} Files
              </span>
              <strong className={libHealth.data?.health?.files.status === 'Attention' ? 'bad' : 'ok'}>{libHealth.data?.health?.files.status}</strong>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.9rem' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-secondary)' }}>
                {libHealth.data?.health?.structure.status === 'Great' ? <CheckCircle2 size={14} color="#10b981" /> : <AlertCircle size={14} color="#ef4444" />} Structure
              </span>
              <strong className={libHealth.data?.health?.structure.status === 'Attention' ? 'bad' : 'ok'}>{libHealth.data?.health?.structure.status}</strong>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.9rem' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-secondary)' }}>
                {libHealth.data?.health?.duplicates.status === 'Clean' ? <CheckCircle2 size={14} color="#10b981" /> : <AlertCircle size={14} color="#ef4444" />} Duplicates
              </span>
              <strong className={libHealth.data?.health?.duplicates.status === 'Attention' ? 'bad' : 'ok'}>{libHealth.data?.health?.duplicates.status}</strong>
            </div>
          </div>
        </div>
        
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
      <section className="v2-card v2-sync"><div><span className="v2-kicker success"><CloudUpload/> Audiobookshelf</span><h2>{health.data?.absConnected ? "Connected and ready" : "Connection needs attention"}</h2><p>Sync metadata and collection changes to the canonical library when you are ready.</p></div><button className="v2-button v2-success" disabled={sync.isPending || !health.data?.absConnected} onClick={() => sync.mutate()}>{sync.isPending ? <RefreshCw className="spin"/> : <CloudUpload/>} Push sync</button></section>
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
