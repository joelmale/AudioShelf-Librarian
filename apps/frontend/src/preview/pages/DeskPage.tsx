import { ArrowRight, BookCopy, CheckCircle2, CloudUpload, FolderInput, RefreshCw, Sparkles, Tags, WandSparkles } from "lucide-react";
import { Link } from "react-router-dom";
import { api, useCollections, useEncodeQueue, useHealth, useLog, useMutation, useOperations, useTagStats } from "../../features/curator/api.js";
import { useToast } from "../../features/curator/toast.js";

export function DeskPage() {
  const health = useHealth();
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

  return <div className="v2-page">
    <div className="v2-page-heading"><div><span className="v2-eyebrow">Expert overview</span><h1>Your librarian’s briefing</h1><p>Evidence-backed recommendations and live work across your sidecar.</p></div><span className="v2-live"><span className={`v2-dot ${health.data?.absConnected ? "ok" : "bad"}`}/> Live system</span></div>
    <div className="v2-bento">
      <section className="v2-card v2-trends"><div className="v2-card-head"><div><span className="v2-kicker"><Sparkles/> Scout intelligence</span><h2>Find what deserves a place next</h2></div><Link to="/scout/trends">View trends <ArrowRight/></Link></div><p>Compare bestseller signals, inspect candidates, and hand selected titles to qBittorrent without leaving the librarian workflow.</p><div className="v2-mini-actions"><Link to="/scout/trends"><Sparkles/> Trending now</Link><Link to="/scout/search"><BookCopy/> Search sources</Link></div></section>
      <section className="v2-card v2-review"><div className="v2-card-head"><span className="v2-kicker warning"><CheckCircle2/> Needs review</span><strong className="v2-big-number">{reviewCount}</strong></div><Link className="v2-metric" to="/curate/tags"><span><Tags/><b>Metadata & tags</b></span><strong>{stats.data?.untaggedBooks ?? "—"}</strong></Link><Link className="v2-metric" to="/curate/collections"><span><BookCopy/><b>Collection proposals</b></span><strong>{proposed}</strong></Link></section>
      <section className="v2-card v2-active"><span className="v2-kicker cyan"><WandSparkles/> Active work</span>{active ? <><div className="v2-progress-title"><div><h2>{active.type}</h2><p>{active.progress.message || active.status}</p></div><strong>{pct}%</strong></div><div className="v2-progress"><i style={{"--progress": `${pct}%`} as React.CSSProperties}/></div><Link className="v2-button v2-button-secondary" to={`/activity/${active.id}`}>View operation</Link></> : <div className="v2-empty-compact"><h2>Everything is quiet</h2><p>No scan, curation, or conversion job is currently running.</p><Link to="/curate/encode">Review M4B candidates</Link></div>}</section>
      <section className="v2-card v2-plan"><span className="v2-kicker"><FolderInput/> Filesystem safety</span><h2>Review before files move</h2><div className="v2-path"><small>Current intake</small><code>…/downloads/author-title/</code></div><ArrowRight className="v2-path-arrow"/><div className="v2-path"><small>Preferred structure</small><code>…/Author/Series/01 - Title/</code></div><Link className="v2-button v2-button-secondary" to="/process/organize">Review proposed changes</Link></section>
      <section className="v2-card v2-sync"><div><span className="v2-kicker success"><CloudUpload/> Audiobookshelf</span><h2>{health.data?.absConnected ? "Connected and ready" : "Connection needs attention"}</h2><p>Sync metadata and collection changes to the canonical library when you are ready.</p></div><button className="v2-button v2-success" disabled={sync.isPending || !health.data?.absConnected} onClick={() => sync.mutate()}>{sync.isPending ? <RefreshCw className="spin"/> : <CloudUpload/>} Push sync</button></section>
      <aside className="v2-card v2-queue"><div className="v2-card-head"><span className="v2-kicker">Task queue</span><b>{queue.data?.length ?? 0}</b></div>{(queue.data ?? []).slice(0,4).map((item) => <Link key={item.id} className="v2-queue-row" to="/curate/encode"><span><WandSparkles/><span><b>{item.name}</b><small>{item.status}</small></span></span><i className={`v2-status ${item.status}`}/></Link>)}{(queue.data ?? []).length === 0 && <p className="v2-muted">No conversion jobs queued.</p>}<h3>Recent audit</h3>{(log.data ?? []).slice(0,4).map((entry) => <div className="v2-audit" key={entry.id}><CheckCircle2/><span><b>{entry.operation}</b><small>{new Date(entry.startedAt).toLocaleString()}</small></span></div>)}</aside>
    </div>
  </div>;
}
