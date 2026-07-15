import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Activity, BookOpenCheck, Bot, ChevronDown, CirclePlus, Download, FolderCog, LayoutDashboard, Menu, Search, Settings as SettingsIcon, Sparkles, WandSparkles, X } from "lucide-react";
import React from "react";
import { DeskPage } from "./pages/DeskPage.js";
import { useHealth, useOperations } from "../features/curator/api.js";
import "./preview.css";

const ScoutPage = React.lazy(async () => ({ default: (await import("./pages/ScoutPage.js")).ScoutPage }));
const ProcessPage = React.lazy(async () => ({ default: (await import("./pages/ProcessPage.js")).ProcessPage }));
const RealignPage = React.lazy(async () => ({ default: (await import("./pages/RealignPage.js")).RealignPage }));
const CuratePage = React.lazy(async () => ({ default: (await import("./pages/CuratePage.js")).CuratePage }));
const BookDetail = React.lazy(async () => ({ default: (await import("../features/curator/pages/BookDetail.js")).BookDetail }));
const CollectionDetail = React.lazy(async () => ({ default: (await import("../features/curator/pages/CollectionDetail.js")).CollectionDetail }));
const JobDetailPage = React.lazy(async () => ({ default: (await import("../features/curator/features/encoder/pages/JobDetailPage.js")).JobDetailPage }));
const UnifiedLogsPage = React.lazy(async () => ({ default: (await import("../features/logs/UnifiedLogsPage.js")).UnifiedLogsPage }));
const PreviewSettingsDialog = React.lazy(async () => ({ default: (await import("./components/PreviewSettingsDialog.js")).PreviewSettingsDialog }));
const HealthReportPage = React.lazy(async () => ({ default: (await import("./pages/HealthReportPage.js")).HealthReportPage }));

const NAV = [
  ["desk", "Desk", LayoutDashboard], ["scout/trends", "Scout & Acquire", Search],
  ["curate/review", "Curate", BookOpenCheck],
  ["process/scan", "Process", FolderCog], ["activity", "Activity", Activity],
] as const;

function DeferredRoute({ label, children }: React.PropsWithChildren<{ label: string }>) {
  return <React.Suspense fallback={<div className="v2-route-loading" role="status">Loading {label}…</div>}>{children}</React.Suspense>;
}

function PreviewShell() {
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [taskOpen, setTaskOpen] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const health = useHealth();
  const operations = useOperations();
  const navigate = useNavigate();
  const location = useLocation();
  const active = (operations.data ?? []).find((op) => !["completed", "cancelled", "error"].includes(op.status));
  const pct = active?.progress?.total ? Math.round(active.progress.current / active.progress.total * 100) : 0;
  const title = NAV.find(([path]) => location.pathname.startsWith(`/${path.split("/")[0]}`))?.[1] ?? "Librarian";

  const go = (path: string) => { setTaskOpen(false); setMobileOpen(false); navigate(`/${path}`); };
  const openSettings = React.useCallback(() => setSettingsOpen(true), []);
  const closeSettings = React.useCallback(() => setSettingsOpen(false), []);
  return (
    <div className="v2-app">
      <aside className={`v2-rail ${mobileOpen ? "is-open" : ""}`}>
        <div className="v2-brand"><span className="v2-brand-mark"><Sparkles /></span><span><strong>AudioShelf</strong><small>Librarian</small></span></div>
        <nav aria-label="Primary navigation">
          {NAV.map(([to, label, Icon]) => {
            const group = to.split("/")[0];
            return <NavLink key={to} to={`/${to}`} onClick={() => setMobileOpen(false)} className={location.pathname.startsWith(`/${group}`) ? "active" : ""}><Icon/><span>{label}</span></NavLink>;
          })}
        </nav>
        <div className="v2-connection"><span className={`v2-dot ${health.data?.absConnected ? "ok" : "bad"}`}/><span>Audiobookshelf<small>{health.isLoading ? "Checking…" : health.data?.absConnected ? "Connected" : "Unavailable"}</small></span></div>
      </aside>

      <section className="v2-workspace">
        <header className="v2-topbar">
          <button className="v2-icon-button v2-mobile-menu" aria-label="Open menu" onClick={() => setMobileOpen(!mobileOpen)}>{mobileOpen ? <X/> : <Menu/>}</button>
          <div className="v2-mobile-title"><strong>{title}</strong><small><span className="v2-dot ok"/> Live system</small></div>
          <button className="v2-command" onClick={() => go("scout/search")}><Search/><span>Ask your librarian or search tasks…</span><kbd>Ctrl K</kbd></button>
          {active && <button className="v2-active-top" onClick={() => go(`activity/${active.id}`)}><Bot/><span>{active.type}</span><strong>{pct}%</strong></button>}
          <button className="v2-button v2-new-task" onClick={() => setTaskOpen(true)}><CirclePlus/> New task</button>
          <button className="v2-icon-button v2-settings-trigger" aria-label="Open settings" aria-expanded={settingsOpen} onClick={openSettings}><SettingsIcon/></button>
        </header>
        <main className="v2-main"><Routes>
          <Route path="desk" element={<DeskPage/>}/>
          <Route path="scout/trends" element={<DeferredRoute label="Scout"><ScoutPage mode="trends"/></DeferredRoute>}/>
          <Route path="scout/search" element={<DeferredRoute label="Scout"><ScoutPage mode="search"/></DeferredRoute>}/>
          <Route path="scout/recommendations" element={<DeferredRoute label="recommendations"><ScoutPage mode="recommendations"/></DeferredRoute>}/>
          <Route path="acquire/downloads" element={<Navigate to="/scout/search" replace/>}/>
          <Route path="acquire/intake" element={<Navigate to="/process/scan" replace/>}/>
          <Route path="curate/review" element={<DeferredRoute label="Curate"><CuratePage section="books"/></DeferredRoute>}/>
          <Route path="curate/books/:id" element={<DeferredRoute label="book details"><div className="v2-page v2-curate-surface"><BookDetail backPath="/curate/review"/></div></DeferredRoute>}/>
          <Route path="curate/encode" element={<DeferredRoute label="M4B candidates"><CuratePage section="encode"/></DeferredRoute>}/>
          <Route path="curate/encode/jobs" element={<DeferredRoute label="encode history"><div className="v2-page v2-curate-surface"><JobDetailPage backPath="/curate/encode"/></div></DeferredRoute>}/>
          <Route path="curate/collections" element={<DeferredRoute label="collections"><CuratePage section="collections"/></DeferredRoute>}/>
          <Route path="curate/collections/:id" element={<DeferredRoute label="collection details"><div className="v2-page v2-curate-surface"><CollectionDetail collectionsPath="/curate/collections" booksPath="/curate/books"/></div></DeferredRoute>}/>
          <Route path="curate/tags" element={<DeferredRoute label="tags"><CuratePage section="tags"/></DeferredRoute>}/>
          <Route path="curate/health" element={<DeferredRoute label="library health"><HealthReportPage/></DeferredRoute>}/>
          <Route path="process/scan" element={<DeferredRoute label="scanner"><ProcessPage mode="scan"/></DeferredRoute>}/>
          <Route path="process/review" element={<DeferredRoute label="scan review"><ProcessPage mode="review"/></DeferredRoute>}/>
          <Route path="process/organize" element={<DeferredRoute label="organizer"><ProcessPage mode="review"/></DeferredRoute>}/>
          <Route path="process/realign" element={<DeferredRoute label="realign"><RealignPage/></DeferredRoute>}/>
          <Route path="process/encode" element={<Navigate to="/curate/encode" replace/>}/>
          <Route path="process/encode/jobs" element={<Navigate to="/curate/encode/jobs" replace/>}/>
          <Route path="activity" element={<DeferredRoute label="activity"><UnifiedLogsPage/></DeferredRoute>}/>
          <Route path="activity/:id" element={<DeferredRoute label="activity"><UnifiedLogsPage/></DeferredRoute>}/>
          <Route path="settings" element={<SettingsDeepLink onOpen={openSettings}/>}/>
          <Route path="*" element={<Navigate to="desk" replace/>}/>
        </Routes></main>
      </section>

      {active && <button className="v2-job-capsule" onClick={() => go(`activity/${active.id}`)}><span><strong>{active.type}</strong><small>{active.progress.message || active.status}</small></span><b>{pct}%</b></button>}
      <nav className="v2-bottom-nav" aria-label="Mobile navigation">
        {[["desk","Desk",LayoutDashboard],["scout/trends","Scout & Acquire",Search],["curate/review","Curate",BookOpenCheck],["activity","Activity",Activity]].map(([to,label,Icon]: any) => <NavLink key={to} to={`/${to}`}><Icon/><span>{label}</span></NavLink>)}
        <button type="button" aria-label="Open settings" aria-expanded={settingsOpen} onClick={openSettings}><SettingsIcon/><span>Settings</span></button>
      </nav>
      <button className="v2-mobile-fab" aria-label="New task" onClick={() => setTaskOpen(true)}><CirclePlus/></button>

      {taskOpen && <div className="v2-overlay" onMouseDown={() => setTaskOpen(false)}><section className="v2-sheet" role="dialog" aria-modal="true" aria-labelledby="new-task-title" onMouseDown={(e) => e.stopPropagation()}><div className="v2-sheet-handle"/><div className="v2-sheet-head"><div><span className="v2-eyebrow">Live system</span><h2 id="new-task-title">Start a task</h2></div><button className="v2-icon-button" onClick={() => setTaskOpen(false)}><X/></button></div><div className="v2-task-grid">
        <button onClick={() => go("scout/search")}><Download/><span><strong>Acquire</strong><small>Find and send a title to downloads</small></span><ChevronDown/></button>
        <button onClick={() => go("process/scan")}><Search/><span><strong>Scan</strong><small>Inspect an intake directory</small></span><ChevronDown/></button>
        <button onClick={() => go("process/organize")}><FolderCog/><span><strong>Organize</strong><small>Review proposed filesystem changes</small></span><ChevronDown/></button>
        <button onClick={() => go("curate/encode")}><WandSparkles/><span><strong>Convert</strong><small>Review books that need M4B</small></span><ChevronDown/></button>
      </div></section></div>}
      {settingsOpen && <DeferredRoute label="settings"><PreviewSettingsDialog open onClose={closeSettings}/></DeferredRoute>}
    </div>
  );
}

function SettingsDeepLink({ onOpen }: { onOpen: () => void }) {
  const { search, hash } = useLocation();
  React.useEffect(() => { onOpen(); }, [onOpen]);
  return <Navigate to={{ pathname: "/desk", search, hash }} replace/>;
}

export default function PreviewApp() {
  return <div id="ui-v2-root" data-ui-version="v2"><div id="ui-v2-portals"/><PreviewShell/></div>;
}
